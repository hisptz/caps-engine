import { describe, it, expect } from "vitest";
import { climateOpenEoConfigSchema } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import {
  openEoPeriodTypeFromConfig,
  temporalExtentFromPeriod,
} from "@/services/worker/utils/period.ts";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    datasetId: "era5land_precipitation_monthly",
    exportId: "rainfall-monthly",
    aggregation: {
      method: "mean",
    },
    period: {
      periodType: "monthly",
      id: "202601",
    },
    orgUnit: {
      ids: ["OU_ALPHA"],
    },
    ...overrides,
  };
}

describe("climateOpenEoConfigSchema", () => {
  it("passes for valid config", () => {
    expect(climateOpenEoConfigSchema.safeParse(baseConfig()).success).toBe(true);
  });

  it("fails when period.id is missing", () => {
    const cfg = baseConfig({ period: { periodType: "monthly" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("fails when orgUnit has no levels or ids", () => {
    expect(climateOpenEoConfigSchema.safeParse(baseConfig({ orgUnit: {} })).success).toBe(false);
  });

  it("passes with lastDays instead of a period id", () => {
    const cfg = baseConfig({ period: { periodType: "daily", lastDays: 35 } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("fails when the period has neither id nor lastDays", () => {
    const cfg = baseConfig({ period: { periodType: "daily" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("fails for an export id OCS would not accept", () => {
    expect(
      climateOpenEoConfigSchema.safeParse(baseConfig({ exportId: "rainfall monthly" })).success
    ).toBe(false);
    expect(climateOpenEoConfigSchema.safeParse(baseConfig({ exportId: "-rainfall" })).success).toBe(
      false
    );
  });

  it("passes with a data element instead of an export", () => {
    const cfg = baseConfig({ exportId: undefined, variable: { dataElement: "QRvJclmKq2g" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("fails with both an export and a data element", () => {
    const cfg = baseConfig({ variable: { dataElement: "QRvJclmKq2g" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("fails with neither an export nor a data element", () => {
    const cfg = baseConfig({ exportId: undefined });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("fails for an invalid data element id", () => {
    const cfg = baseConfig({ exportId: undefined, variable: { dataElement: "short" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("temporalExtentFromPeriod", () => {
  it("derives ISO date range from monthly period id", () => {
    const [start, end] = temporalExtentFromPeriod({ periodType: "monthly", id: "202601" });
    expect(start).toBe("2026-01-01");
    expect(end).toBe("2026-01-31");
  });

  it("covers the lastDays days up to yesterday when there is no id", () => {
    const now = new Date("2026-10-09T13:00:00Z");
    expect(temporalExtentFromPeriod({ periodType: "daily", lastDays: 35 }, now)).toEqual([
      "2026-09-04",
      "2026-10-08",
    ]);
  });

  describe("rolling", () => {
    const now = new Date("2026-10-09T13:00:00Z");

    it("ends at the last complete day by default, like lastDays", () => {
      expect(
        temporalExtentFromPeriod({ mode: "rolling", periodType: "daily", count: 35 }, now)
      ).toEqual(["2026-09-04", "2026-10-08"]);
    });

    it("skips recent days with an offset, for sources that publish late", () => {
      expect(
        temporalExtentFromPeriod(
          { mode: "rolling", periodType: "daily", count: 40, offset: 30 },
          now
        )
      ).toEqual(["2026-08-01", "2026-09-09"]);
    });

    it("covers whole months, never starting mid-month", () => {
      expect(
        temporalExtentFromPeriod({ mode: "rolling", periodType: "monthly", count: 3 }, now)
      ).toEqual(["2026-07-01", "2026-09-30"]);
    });

    it("covers whole ISO weeks, Monday to Sunday", () => {
      // 2026-10-09 is a Friday in ISO week 41, so the last complete week is week 40.
      expect(
        temporalExtentFromPeriod({ mode: "rolling", periodType: "weekly", count: 2 }, now)
      ).toEqual(["2026-09-21", "2026-10-04"]);
    });

    it("includes the current, incomplete period with offset 0", () => {
      expect(
        temporalExtentFromPeriod(
          { mode: "rolling", periodType: "monthly", count: 1, offset: 0 },
          now
        )
      ).toEqual(["2026-10-01", "2026-10-31"]);
    });

    it("crosses a year boundary", () => {
      expect(
        temporalExtentFromPeriod(
          { mode: "rolling", periodType: "monthly", count: 2 },
          new Date("2026-01-15T00:00:00Z")
        )
      ).toEqual(["2025-11-01", "2025-12-31"]);
    });
  });
});

describe("climateOpenEoConfigSchema period", () => {
  const period = (value: unknown) =>
    climateOpenEoConfigSchema.safeParse(baseConfig({ period: value })).success;

  it("accepts fixed, rolling and lastDays periods", () => {
    expect(period({ periodType: "monthly", id: "202601", endId: "202603" })).toBe(true);
    expect(period({ mode: "fixed", periodType: "monthly", id: "202601" })).toBe(true);
    expect(period({ mode: "rolling", periodType: "monthly", count: 3 })).toBe(true);
    expect(period({ mode: "rolling", periodType: "daily", count: 40, offset: 30 })).toBe(true);
    expect(period({ periodType: "daily", lastDays: 35 })).toBe(true);
  });

  it("refuses a period that mixes fixed and rolling fields", () => {
    expect(period({ periodType: "daily", id: "20180101", lastDays: 35 })).toBe(false);
    expect(period({ mode: "rolling", periodType: "daily", count: 35, id: "20180101" })).toBe(false);
    expect(period({ periodType: "daily", lastDays: 35, endId: "20181231" })).toBe(false);
  });

  it("refuses lastDays for weekly or monthly data, whose periods days do not line up with", () => {
    expect(period({ periodType: "monthly", lastDays: 35 })).toBe(false);
    expect(period({ periodType: "weekly", lastDays: 35 })).toBe(false);
  });

  it("caps the window per period type", () => {
    expect(period({ mode: "rolling", periodType: "daily", count: 400 })).toBe(true);
    expect(period({ mode: "rolling", periodType: "daily", count: 401 })).toBe(false);
    expect(period({ mode: "rolling", periodType: "monthly", count: 37 })).toBe(false);
    expect(period({ periodType: "daily", lastDays: 401 })).toBe(false);
  });

  it("refuses an empty or negative window", () => {
    expect(period({ mode: "rolling", periodType: "daily", count: 0 })).toBe(false);
    expect(period({ mode: "rolling", periodType: "daily", count: 5, offset: -1 })).toBe(false);
  });
});

describe("openEoPeriodTypeFromConfig", () => {
  it("maps period types to openEO period_type values", () => {
    expect(openEoPeriodTypeFromConfig("daily")).toBe("day");
    expect(openEoPeriodTypeFromConfig("weekly")).toBe("week");
    expect(openEoPeriodTypeFromConfig("monthly")).toBe("month");
  });
});
