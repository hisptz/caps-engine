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
