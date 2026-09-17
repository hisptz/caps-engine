import { describe, it, expect } from "vitest";
import { climateOpenEoConfigSchema } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import {
  openEoPeriodTypeFromConfig,
  temporalExtentFromPeriod,
} from "@/services/worker/utils/period.ts";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    datasetId: "era5land_precipitation_monthly",
    variable: {
      dataElement: "AbCdEfGhIjK",
    },
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

  it("fails for invalid data element id", () => {
    const cfg = baseConfig({ variable: { dataElement: "short" } });
    expect(climateOpenEoConfigSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("temporalExtentFromPeriod", () => {
  it("derives ISO date range from monthly period id", () => {
    const [start, end] = temporalExtentFromPeriod({ periodType: "monthly", id: "202601" });
    expect(start).toBe("2026-01-01");
    expect(end).toBe("2026-01-31");
  });
});

describe("openEoPeriodTypeFromConfig", () => {
  it("maps period types to openEO period_type values", () => {
    expect(openEoPeriodTypeFromConfig("daily")).toBe("day");
    expect(openEoPeriodTypeFromConfig("weekly")).toBe("week");
    expect(openEoPeriodTypeFromConfig("monthly")).toBe("month");
  });
});
