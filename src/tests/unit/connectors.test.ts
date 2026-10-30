import { describe, expect, it } from "vitest";
import {
  findConnectorCycle,
  resolveInputMapping,
  validateTargetPath,
} from "@/shared/pipeline/connectors.ts";

describe("resolveInputMapping", () => {
  const context = {
    step_0_output: { orgUnits: ["ou1"], period: "2026-11" },
    scheduledAt: "2026-10-29T00:00:00Z",
  };

  it("copies mapped values into the target keys", () => {
    expect(
      resolveInputMapping(
        { orgUnits: "step_0_output.orgUnits", period: "step_0_output.period" },
        context
      )
    ).toEqual({ orgUnits: ["ou1"], period: "2026-11" });
  });

  it("leaves out paths that resolve to nothing", () => {
    expect(resolveInputMapping({ missing: "step_3_output.x", at: "scheduledAt" }, context)).toEqual(
      { at: "2026-10-29T00:00:00Z" }
    );
  });

  it("nests dotted target paths so step handlers can read them", () => {
    expect(
      resolveInputMapping(
        {
          "steps.step-a.orgUnits": "step_0_output.orgUnits",
          "steps.step-a.period": "step_0_output.period",
        },
        context
      )
    ).toEqual({ steps: { "step-a": { orgUnits: ["ou1"], period: "2026-11" } } });
  });

  it("never writes reserved prototype keys", () => {
    const input = resolveInputMapping({ "__proto__.polluted": "scheduledAt" }, context);
    expect(input).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns an empty context for an empty mapping", () => {
    expect(resolveInputMapping({}, context)).toEqual({});
  });
});

describe("findConnectorCycle", () => {
  const edge = (sourcePipelineId: string, targetPipelineId: string) => ({
    sourcePipelineId,
    targetPipelineId,
  });

  it("rejects a connector from a pipeline to itself", () => {
    expect(findConnectorCycle([], edge("A", "A"))).toEqual(["A", "A"]);
  });

  it("finds a direct loop", () => {
    expect(findConnectorCycle([edge("B", "A")], edge("A", "B"))).toEqual(["A", "B", "A"]);
  });

  it("finds a longer loop", () => {
    expect(findConnectorCycle([edge("B", "C"), edge("C", "A")], edge("A", "B"))).toEqual([
      "A",
      "B",
      "C",
      "A",
    ]);
  });

  it("allows chains and fan-out without loops", () => {
    expect(
      findConnectorCycle([edge("A", "C"), edge("B", "C"), edge("C", "D")], edge("A", "B"))
    ).toBeNull();
  });

  it("terminates on an existing loop elsewhere in the graph", () => {
    expect(findConnectorCycle([edge("X", "Y"), edge("Y", "X")], edge("A", "B"))).toBeNull();
  });
});

describe("validateTargetPath", () => {
  it("accepts plain and nested paths", () => {
    expect(validateTargetPath("alertCount")).toBeNull();
    expect(validateTargetPath("steps.abc.orgUnits")).toBeNull();
  });

  it("rejects empty segments and reserved names", () => {
    expect(validateTargetPath("steps..x")).toMatch(/empty segment/);
    expect(validateTargetPath("a.constructor.b")).toMatch(/reserved name/);
  });
});
