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

  it("deep-merges context override onto handlerConfig", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {
        steps: {
          "step-1": {
            period: { periodOffset: 1, numberOfPeriodsToGenerate: 6 },
          },
        },
      },
      stepId: "step-1",
    });
    expect(merged.period).toEqual({
      endPeriod: "202608",
      periodOffset: 1,
      numberOfPeriodsToGenerate: 6,
    });
    expect(merged.predictionSetupId).toBe(3);
  });

  it("throws when context override is invalid", () => {
    expect(() =>
      resolveEffectiveHandlerConfig({
        handlerKey: "prediction-trigger",
        handlerConfig: baseConfig,
        pipelineContext: {
          steps: {
            "step-1": {
              period: { periodOffset: "last" },
            },
          },
        },
        stepId: "step-1",
      })
    ).toThrow(EffectiveHandlerConfigError);
  });
});
