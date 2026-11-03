import { describe, expect, it } from "vitest";
import { MergeTriggerRule, PipelineExecutionStatus } from "@db/client";
import { decideMerge, mergeSourceContexts } from "@/shared/pipeline/merges.ts";
import { findEntryPipelineIds, mergeEdges } from "@/shared/pipeline/workflows.ts";

const { COMPLETED, FAILED } = PipelineExecutionStatus;
const sources = [
  { pipelineId: "disease", name: "Disease data" },
  { pipelineId: "climate", name: "Climate data" },
];
const deadlineAt = new Date("2026-11-01T12:00:00Z");
const before = new Date("2026-11-01T11:00:00Z");
const after = new Date("2026-11-01T12:00:01Z");

function decide(
  arrivals: { pipelineId: string; status: PipelineExecutionStatus }[],
  opts: { triggerRule?: MergeTriggerRule; now?: Date } = {}
) {
  return decideMerge({
    triggerRule: opts.triggerRule ?? MergeTriggerRule.ALL_SUCCEEDED,
    sources,
    arrivals,
    deadlineAt,
    now: opts.now ?? before,
  });
}

describe("decideMerge", () => {
  it("waits until every source has arrived", () => {
    expect(decide([{ pipelineId: "disease", status: COMPLETED }])).toEqual({ kind: "wait" });
  });

  it("is ready once every source succeeded", () => {
    expect(
      decide([
        { pipelineId: "disease", status: COMPLETED },
        { pipelineId: "climate", status: COMPLETED },
      ])
    ).toEqual({ kind: "ready", status: COMPLETED });
  });

  it("fails straight away when a source fails under All succeeded", () => {
    expect(decide([{ pipelineId: "climate", status: FAILED }])).toEqual({
      kind: "fail",
      reason: "Did not succeed: Climate data",
    });
  });

  it("waits for everyone under All done, then reports the failure as the status", () => {
    const allDone = { triggerRule: MergeTriggerRule.ALL_DONE };
    expect(decide([{ pipelineId: "climate", status: FAILED }], allDone)).toEqual({
      kind: "wait",
    });
    expect(
      decide(
        [
          { pipelineId: "climate", status: FAILED },
          { pipelineId: "disease", status: COMPLETED },
        ],
        allDone
      )
    ).toEqual({ kind: "ready", status: FAILED });
  });

  it("times out after the deadline, naming who is missing", () => {
    expect(decide([{ pipelineId: "disease", status: COMPLETED }], { now: after })).toEqual({
      kind: "time_out",
      reason: "Did not finish in time: Climate data",
    });
  });
});

describe("mergeSourceContexts", () => {
  it("puts every source's step results side by side", () => {
    expect(
      mergeSourceContexts([
        { stepOutputs: { s1: { count: 3 } }, other: 1 },
        { stepOutputs: { s2: { imported: 5 } } },
        null,
      ])
    ).toEqual({ stepOutputs: { s1: { count: 3 }, s2: { imported: 5 } } });
  });
});

describe("merges in a workflow", () => {
  it("do not start the run with the pipeline a merge starts", () => {
    expect(
      findEntryPipelineIds(
        ["disease", "climate", "prediction"],
        mergeEdges([
          {
            targetPipelineId: "prediction",
            sources: [{ pipelineId: "disease" }, { pipelineId: "climate" }],
          },
        ])
      )
    ).toEqual(["disease", "climate"]);
  });
});
