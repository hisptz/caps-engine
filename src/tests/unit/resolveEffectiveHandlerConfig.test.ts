import { describe, it, expect } from "vitest";
import {
  extractStepContextOverride,
  EffectiveHandlerConfigError,
  resolveEffectiveHandlerConfig,
} from "@/services/worker/utils/resolveEffectiveHandlerConfig.ts";

const baseConfig = {
  backtestId: 2,
  predictionSetupId: 3,
  name: "run-1",
  period: { endPeriod: "202608", numberOfPeriodsToGenerate: 3 },
};

describe("extractStepContextOverride", () => {
  it("returns undefined when steps is missing", () => {
    expect(extractStepContextOverride({}, "step-1")).toBeUndefined();
  });

  it("returns slice for step id", () => {
    const override = { orgUnit: { ids: ["ou-ctx"] } };
    expect(extractStepContextOverride({ steps: { "step-1": override } }, "step-1")).toEqual(
      override
    );
  });
});

describe("resolveEffectiveHandlerConfig", () => {
  it("returns base config when no override", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {},
      stepId: "step-1",
    });
    expect(merged).toEqual(baseConfig);
  });

  it("replaces the step's period with the context's", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {
        steps: {
          "step-1": {
            period: { endPeriod: "202610", numberOfPeriodsToGenerate: 6 },
          },
        },
      },
      stepId: "step-1",
    });
    expect(merged.period).toEqual({
      endPeriod: "202610",
      numberOfPeriodsToGenerate: 6,
    });
    expect(merged.predictionSetupId).toBe(3);
  });

  it("lets a schedule's offset replace the step's fixed end period", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {
        steps: {
          "step-1": {
            period: { periodOffset: 1, numberOfPeriodsToGenerate: 3 },
          },
        },
      },
      stepId: "step-1",
    });
    expect(merged.period).toEqual({ periodOffset: 1, numberOfPeriodsToGenerate: 3 });
  });

  it("deep-merges keys the handler does not replace", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {
        steps: {
          "step-1": {
            period: { endPeriod: "202610", numberOfPeriodsToGenerate: 6 },
          },
        },
      },
      stepId: "step-1",
    });
    expect(merged.name).toBe("run-1");
    expect(merged.backtestId).toBe(2);
  });

  it("throws when context override is invalid", () => {
    expect(() =>
      resolveEffectiveHandlerConfig({
        handlerKey: "prediction-trigger",
        handlerConfig: baseConfig,
        pipelineContext: {
          steps: {
            "step-1": {
              period: { endPeriod: "" },
            },
          },
        },
        stepId: "step-1",
      })
    ).toThrow(EffectiveHandlerConfigError);
  });
});

describe("resolveEffectiveHandlerConfig for climate-openeo-create", () => {
  const climateConfig = (period: Record<string, unknown>) => ({
    datasetId: "chirps3_precipitation_daily",
    variable: { dataElement: "QRvJclmKq2g" },
    aggregation: { method: "mean" },
    period,
    orgUnit: { levels: ["2"] },
  });
  const resolve = (stepPeriod: Record<string, unknown>, runPeriod: Record<string, unknown>) =>
    resolveEffectiveHandlerConfig({
      handlerKey: "climate-openeo-create",
      handlerConfig: climateConfig(stepPeriod),
      pipelineContext: {
        steps: { "step-1": { period: runPeriod, orgUnit: { levels: ["2"] } } },
      },
      stepId: "step-1",
    });

  it("lets a fixed backfill replace a rolling step's period", () => {
    const merged = resolve(
      { mode: "rolling", periodType: "daily", count: 35 },
      { periodType: "daily", id: "20180101", endId: "20181231" }
    );
    expect(merged.period).toEqual({ periodType: "daily", id: "20180101", endId: "20181231" });
  });

  it("lets a rolling run replace a fixed step's period, leaving no id behind", () => {
    const merged = resolve(
      { periodType: "daily", id: "20260101" },
      { mode: "rolling", periodType: "daily", count: 7 }
    );
    expect(merged.period).toEqual({ mode: "rolling", periodType: "daily", count: 7 });
  });
});

describe("climate-openeo-create context without a period", () => {
  const stepConfig = {
    datasetId: "chirps3_precipitation_daily",
    variable: { dataElement: "QRvJclmKq2g" },
    aggregation: { method: "mean" },
    period: { mode: "rolling", periodType: "daily", count: 35 },
    orgUnit: { levels: ["2"] },
  };
  const resolve = (override: Record<string, unknown>) =>
    resolveEffectiveHandlerConfig({
      handlerKey: "climate-openeo-create",
      handlerConfig: stepConfig,
      pipelineContext: { steps: { "step-1": override } },
      stepId: "step-1",
    });

  it("keeps the step's period when a schedule only overrides org units", () => {
    const merged = resolve({ orgUnit: { levels: ["3"] } });
    expect(merged.period).toEqual(stepConfig.period);
    expect(merged.orgUnit).toEqual({ levels: ["3"] });
  });

  it("replaces the step's org units rather than merging them", () => {
    const merged = resolve({ orgUnit: { ids: ["W6sNfkJcXGC"] } });
    expect(merged.orgUnit).toEqual({ ids: ["W6sNfkJcXGC"] });
  });

  it("keeps the step's org units when a run only overrides the period", () => {
    const merged = resolve({ period: { periodType: "daily", id: "20260101" } });
    expect(merged.period).toEqual({ periodType: "daily", id: "20260101" });
    expect(merged.orgUnit).toEqual(stepConfig.orgUnit);
  });
});

describe("resolveEffectiveHandlerConfig for dhis2-instance-push", () => {
  const stepConfig = {
    routeCode: "caps-src-hmis",
    items: [{ from: "fbfJHSPpUQD" }],
    orgUnit: { levels: [2] },
    period: { mode: "updated", days: 7 },
  };
  const resolve = (override: Record<string, unknown>) =>
    resolveEffectiveHandlerConfig({
      handlerKey: "dhis2-instance-push",
      handlerConfig: stepConfig,
      pipelineContext: { steps: { "step-1": override } },
      stepId: "step-1",
    });

  it("lets a run backfill a fixed range, leaving no `days` behind", () => {
    const period = { mode: "fixed", periodType: "MONTHLY", start: "202401", end: "202512" };
    expect(resolve({ period }).period).toEqual(period);
  });

  it("rejects an invalid period", () => {
    expect(() => resolve({ period: { mode: "updated", days: 0 } })).toThrow(
      EffectiveHandlerConfigError
    );
  });
});
