import { describe, it, expect } from "vitest";
import {
  extractStepContextOverride,
  EffectiveHandlerConfigError,
  resolveEffectiveHandlerConfig,
} from "@/services/worker/utils/resolveEffectiveHandlerConfig.ts";

const baseConfig = {
  modelId: "model-1",
  name: "run-1",
  orgUnit: { ids: ["ou-config"] },
  period: {
    type: "MONTHLY" as const,
    periodOffset: 0,
    numberPreviousYearsToInclude: 2,
    numberOfPeriodsToGenerate: 3,
  },
  dataSources: [{ covariate: "rain", dataElementId: "abcdefghijk" }],
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
    expect(merged.orgUnit).toEqual({ ids: ["ou-config"] });
  });

  it("deep-merges context override onto handlerConfig", () => {
    const merged = resolveEffectiveHandlerConfig({
      handlerKey: "prediction-trigger",
      handlerConfig: baseConfig,
      pipelineContext: {
        steps: {
          "step-1": {
            orgUnit: { ids: ["ou-runtime"] },
            period: {
              type: "MONTHLY",
              periodOffset: 1,
              numberPreviousYearsToInclude: 2,
              numberOfPeriodsToGenerate: 3,
            },
          },
        },
      },
      stepId: "step-1",
    });
    expect(merged.orgUnit).toEqual({ ids: ["ou-runtime"] });
    expect(merged.period).toMatchObject({ periodOffset: 1 });
    expect(merged.modelId).toBe("model-1");
  });

  it("throws when context override is invalid", () => {
    expect(() =>
      resolveEffectiveHandlerConfig({
        handlerKey: "prediction-trigger",
        handlerConfig: baseConfig,
        pipelineContext: {
          steps: {
            "step-1": {
              orgUnit: { ids: ["ou1"] },
              period: { type: "INVALID" },
            },
          },
        },
        stepId: "step-1",
      })
    ).toThrow(EffectiveHandlerConfigError);
  });
});
