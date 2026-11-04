import { describe, expect, it } from "vitest";
import { periodOverrideForStep, runPeriodRangeSchema } from "@/shared/pipeline/runPeriod.ts";
import { rangeContext } from "@/shared/pipeline/workflows.ts";
import { resolveEffectiveHandlerConfig } from "@/services/worker/utils/resolveEffectiveHandlerConfig.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";

const weekly = { periodType: "WEEKLY" as const, start: "2020W1", end: "2026W43" };

describe("runPeriodRangeSchema", () => {
  it("accepts a range in order and refuses one that ends before it starts", () => {
    expect(runPeriodRangeSchema.safeParse({ mode: "fixed", ...weekly }).success).toBe(true);
    // 2024W9 comes before 2024W10, though not as text
    expect(
      runPeriodRangeSchema.safeParse({
        mode: "fixed",
        periodType: "WEEKLY",
        start: "2024W9",
        end: "2024W10",
      }).success
    ).toBe(true);
    expect(
      runPeriodRangeSchema.safeParse({
        mode: "fixed",
        periodType: "MONTHLY",
        start: "202405",
        end: "202401",
      }).success
    ).toBe(false);
  });

  it("checks the period IDs match the period type", () => {
    expect(
      runPeriodRangeSchema.safeParse({
        mode: "fixed",
        periodType: "MONTHLY",
        start: "2024W1",
        end: "202401",
      }).success
    ).toBe(false);
  });
});

const climateStep = {
  handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
  handlerConfig: {
    datasetId: "era5.precip",
    variable: { dataElement: "RainDataEl1" },
    aggregation: { method: "sum" },
    period: { mode: "rolling", periodType: "weekly", count: 12 },
    orgUnit: { levels: ["3"] },
  },
};

const pullStep = {
  handlerKey: Handlers.DHIS2_INSTANCE_PULL,
  handlerConfig: {
    routeCode: "caps-src-hmis",
    items: [{ from: "CasesDataE1", fromType: "DATA_ELEMENT" }],
    orgUnit: { levels: [3] },
    period: { mode: "relative", periodType: "WEEKLY", count: 12, offset: 1 },
  },
};

describe("periodOverrideForStep", () => {
  it("turns the range into each handler's own fixed period", () => {
    for (const step of [climateStep, pullStep]) {
      const result = periodOverrideForStep(step, weekly);
      expect(result.kind).toBe("override");
      if (result.kind !== "override") continue;
      // The step's settings with the override must still be valid
      const merged = resolveEffectiveHandlerConfig({
        handlerKey: step.handlerKey,
        handlerConfig: step.handlerConfig,
        pipelineContext: { steps: { s: result.override } },
        stepId: "s",
      });
      expect(merged.period).toEqual(
        step === climateStep
          ? { mode: "fixed", periodType: "weekly", id: "2020W1", endId: "2026W43" }
          : { mode: "fixed", periodType: "WEEKLY", start: "2020W1", end: "2026W43" }
      );
    }
  });

  it("leaves steps on another period type alone", () => {
    const daily = {
      ...climateStep,
      handlerConfig: {
        ...climateStep.handlerConfig,
        period: { mode: "rolling", periodType: "daily", count: 30 },
      },
    };
    expect(periodOverrideForStep(daily, weekly)).toEqual({
      kind: "mismatch",
      reason: "Uses daily periods",
    });
    expect(
      periodOverrideForStep({ handlerKey: Handlers.DHIS2_ANALYTICS_RUN, handlerConfig: {} }, weekly)
    ).toEqual({ kind: "none" });
  });
});

describe("rangeContext", () => {
  it("collects overrides by step id and reports steps left on their own window", () => {
    const { context, outsideRange } = rangeContext(
      {
        name: "Climate",
        steps: [
          { id: "a", name: "Request rain", ...climateStep },
          {
            id: "b",
            name: "Request heat",
            ...climateStep,
            handlerConfig: {
              ...climateStep.handlerConfig,
              period: { mode: "rolling", periodType: "monthly", count: 3 },
            },
          },
          {
            id: "c",
            name: "Analytics",
            handlerKey: Handlers.DHIS2_ANALYTICS_RUN,
            handlerConfig: {},
          },
        ],
      },
      weekly
    );
    expect(Object.keys(context.steps as object)).toEqual(["a"]);
    expect(outsideRange).toEqual([
      { pipelineName: "Climate", stepName: "Request heat", reason: "Uses monthly periods" },
    ]);
  });
});
