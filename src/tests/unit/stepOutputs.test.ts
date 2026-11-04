import { describe, expect, it } from "vitest";
import { withStepOutput } from "@/shared/pipeline/stepOutputs.ts";

describe("withStepOutput", () => {
  it("stores a result by position and by step id, keeping earlier results", () => {
    const afterFirst = withStepOutput({ scheduledAt: "t" }, 0, "step-a", { count: 2 });
    const afterSecond = withStepOutput(afterFirst, 1, "step-b", { imported: 5 });

    expect(afterSecond).toEqual({
      scheduledAt: "t",
      step_0_output: { count: 2 },
      step_1_output: { imported: 5 },
      stepOutputs: { "step-a": { count: 2 }, "step-b": { imported: 5 } },
    });
  });

  it("stores null for a step without a result", () => {
    expect(withStepOutput({}, 0, "step-a", undefined)).toEqual({
      step_0_output: null,
      stepOutputs: { "step-a": null },
    });
  });

  it("replaces a malformed stepOutputs value instead of failing", () => {
    expect(withStepOutput({ stepOutputs: "oops" }, 0, "step-a", 1).stepOutputs).toEqual({
      "step-a": 1,
    });
  });
});
