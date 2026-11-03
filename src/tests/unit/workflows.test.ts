import { describe, expect, it } from "vitest";
import { PipelineExecutionStatus } from "@db/client";
import {
  deriveWorkflowRunStatus,
  findEntryPipelineIds,
  WorkflowRunStatus,
} from "@/shared/pipeline/workflows.ts";

const edge = (source: string, target: string, otherwise: string | null = null) => ({
  sourcePipelineId: source,
  targetPipelineId: target,
  otherwisePipelineId: otherwise,
});

describe("findEntryPipelineIds", () => {
  it("starts every member that no other member starts", () => {
    // disease, climateA, climateB -> prediction -> alerts
    const members = ["disease", "climateA", "climateB", "prediction", "alerts"];
    expect(
      findEntryPipelineIds(members, [
        edge("disease", "prediction"),
        edge("climateA", "prediction"),
        edge("prediction", "alerts"),
      ])
    ).toEqual(["disease", "climateA", "climateB"]);
  });

  it("counts an otherwise pipeline as started by another member", () => {
    expect(
      findEntryPipelineIds(
        ["check", "analytics", "fetch"],
        [edge("check", "analytics", "fetch"), edge("fetch", "analytics")]
      )
    ).toEqual(["check"]);
  });

  it("ignores connectors from pipelines outside the workflow", () => {
    expect(findEntryPipelineIds(["a", "b"], [edge("outside", "a"), edge("a", "b")])).toEqual(["a"]);
  });

  it("starts every member when there are no connectors", () => {
    expect(findEntryPipelineIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("deriveWorkflowRunStatus", () => {
  const { COMPLETED, FAILED, RUNNING, CANCELLED } = PipelineExecutionStatus;

  it("is SKIPPED when nothing started", () => {
    expect(deriveWorkflowRunStatus([], 0)).toBe(WorkflowRunStatus.SKIPPED);
  });

  it("is RUNNING while an execution is active or a connector is still deciding", () => {
    expect(deriveWorkflowRunStatus([COMPLETED, RUNNING], 0)).toBe(WorkflowRunStatus.RUNNING);
    expect(deriveWorkflowRunStatus([COMPLETED], 1)).toBe(WorkflowRunStatus.RUNNING);
  });

  it("is FAILED, then CANCELLED, then COMPLETED once everything ended", () => {
    expect(deriveWorkflowRunStatus([COMPLETED, FAILED, CANCELLED], 0)).toBe(
      WorkflowRunStatus.FAILED
    );
    expect(deriveWorkflowRunStatus([COMPLETED, CANCELLED], 0)).toBe(WorkflowRunStatus.CANCELLED);
    expect(deriveWorkflowRunStatus([COMPLETED, COMPLETED], 0)).toBe(WorkflowRunStatus.COMPLETED);
  });
});
