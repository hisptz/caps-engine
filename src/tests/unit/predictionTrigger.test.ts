import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { PeriodTypeEnum } from "@hisptz/dhis2-utils";
import {
  getTrainingPeriods,
  toPeriodType,
} from "@/services/worker/services/handlers/predictionTrigger/utils/data.ts";
import { predictionTriggerConfigSchema } from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";

const september2026 = DateTime.fromISO("2026-09-22T10:00:00");

describe("toPeriodType", () => {
  it("maps CHAP period types onto DHIS2 period types", () => {
    expect(toPeriodType("month")).toBe(PeriodTypeEnum.MONTHLY);
    expect(toPeriodType("week")).toBe(PeriodTypeEnum.WEEKLY);
  });

  it("rejects period types CAPS cannot generate", () => {
    expect(() => toPeriodType("year")).toThrow(/Unsupported period type/);
    expect(() => toPeriodType(null)).toThrow(/Unsupported period type/);
  });
});

describe("getTrainingPeriods", () => {
  it("ends on the previous period for the default offset of 1", () => {
    const periods = getTrainingPeriods({
      startPeriod: "202207",
      periodType: PeriodTypeEnum.MONTHLY,
      periodOffset: 1,
      now: september2026,
    });

    expect(periods[0]).toBe("202207");
    expect(periods.at(-1)).toBe("202608");
    expect(periods).toHaveLength(50);
  });

  it("includes the current, incomplete period at offset 0", () => {
    const periods = getTrainingPeriods({
      startPeriod: "202207",
      periodType: PeriodTypeEnum.MONTHLY,
      periodOffset: 0,
      now: september2026,
    });

    expect(periods.at(-1)).toBe("202609");
  });

  it("walks further back as the offset grows", () => {
    const periods = getTrainingPeriods({
      startPeriod: "202207",
      periodType: PeriodTypeEnum.MONTHLY,
      periodOffset: 3,
      now: september2026,
    });

    expect(periods.at(-1)).toBe("202606");
  });

  it("supports weekly setups", () => {
    const periods = getTrainingPeriods({
      startPeriod: "2026W1",
      periodType: PeriodTypeEnum.WEEKLY,
      periodOffset: 1,
      now: DateTime.fromISO("2026-02-05T10:00:00"),
    });

    expect(periods[0]).toBe("2026W1");
    expect(periods.at(-1)).toBe("2026W5");
  });

  it("fails when the offset pushes the window before the start period", () => {
    expect(() =>
      getTrainingPeriods({
        startPeriod: "202608",
        periodType: PeriodTypeEnum.MONTHLY,
        periodOffset: 6,
        now: september2026,
      })
    ).toThrow(/ends before the setup's start period/);
  });

  it("ends on the period picked on the step when there is no offset", () => {
    const periods = getTrainingPeriods({
      startPeriod: "202207",
      periodType: PeriodTypeEnum.MONTHLY,
      endPeriod: "202604",
      now: september2026,
    });

    expect(periods[0]).toBe("202207");
    expect(periods.at(-1)).toBe("202604");
  });

  it("lets an end period picked for a run win over an offset left on the step", () => {
    const periods = getTrainingPeriods({
      startPeriod: "202207",
      periodType: PeriodTypeEnum.MONTHLY,
      periodOffset: 1,
      endPeriod: "202604",
      now: september2026,
    });

    expect(periods.at(-1)).toBe("202604");
  });

  it("refuses a training period with neither an offset nor an end period", () => {
    expect(() =>
      getTrainingPeriods({
        startPeriod: "202207",
        periodType: PeriodTypeEnum.MONTHLY,
        now: september2026,
      })
    ).toThrow(/either a period offset or an end period/);
  });

  it("rejects a start period it cannot read", () => {
    expect(() =>
      getTrainingPeriods({
        startPeriod: "July 2022",
        periodType: PeriodTypeEnum.MONTHLY,
        periodOffset: 1,
        now: september2026,
      })
    ).toThrow(/start period/);
  });
});

describe("predictionTriggerConfigSchema", () => {
  const setupConfig = {
    backtestId: 2,
    predictionSetupId: 3,
    name: "1st Prediction Disease",
    period: { endPeriod: "202608", numberOfPeriodsToGenerate: 3 },
  };

  it("accepts a prediction-setup config", () => {
    expect(predictionTriggerConfigSchema.safeParse(setupConfig).success).toBe(true);
  });

  it("rejects the old model-based config", () => {
    expect(() =>
      predictionTriggerConfigSchema.parse({
        modelId: "chap_ewars_monthly",
        name: "Dengue monthly",
        orgUnit: { ids: ["OU1"] },
        period: { type: "MONTHLY", periodOffset: 0, numberOfPeriodsToGenerate: 3 },
        dataSources: [{ covariate: "rainfall", dataElementId: "nWPzi91bOBs" }],
      })
    ).toThrow();
  });

  it("requires a run name on a prediction-setup config", () => {
    expect(() => predictionTriggerConfigSchema.parse({ ...setupConfig, name: "" })).toThrow();
  });

  it("accepts a schedule's relative period offset", () => {
    const parsed = predictionTriggerConfigSchema.parse({
      ...setupConfig,
      period: { periodOffset: 1, numberOfPeriodsToGenerate: 3 },
    });
    expect(parsed.period.periodOffset).toBe(1);
  });

  it("requires the training period to have an end period or an offset", () => {
    expect(() =>
      predictionTriggerConfigSchema.parse({
        ...setupConfig,
        period: { numberOfPeriodsToGenerate: 3 },
      })
    ).toThrow();
  });

  it("rejects a negative period offset", () => {
    expect(() =>
      predictionTriggerConfigSchema.parse({
        ...setupConfig,
        period: { periodOffset: -1, numberOfPeriodsToGenerate: 3 },
      })
    ).toThrow();
  });
});
