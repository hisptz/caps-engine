import { describe, it, expect } from "vitest";
import { climateOpenEoConfigSchema } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import { temporalExtentFromPeriod } from "@/services/worker/utils/period.ts";

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
    const cfg = baseConfig({ exportId: "rainfall monthly" });
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

  it("uses the period id over lastDays, so a run can override a rolling config", () => {
    const now = new Date("2026-10-09T13:00:00Z");
    expect(
      temporalExtentFromPeriod(
        { periodType: "daily", id: "20180101", endId: "20181231", lastDays: 35 },
        now
      )
    ).toEqual(["2018-01-01", "2018-12-31"]);
  });
});
