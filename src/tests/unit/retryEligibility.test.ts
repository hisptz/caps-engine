import { describe, expect, it } from "vitest";
import { PipelineExecutionStatus, StepExecutionStatus } from "@db/client";
import { evaluateStepRetryEligibility } from "@/shared/pipeline/retryEligibility.ts";
import { snapshotFromPipelineStep } from "@/shared/pipeline/stepSnapshot.ts";
import { buildMockStep } from "@/tests/utils/helpers.ts";

const snapshot = snapshotFromPipelineStep(
  buildMockStep({
    id: "11111111-1111-1111-1111-111111111111",
    pipelineId: "22222222-2222-2222-2222-222222222222",
  })
) as object;

describe("evaluateStepRetryEligibility", () => {
  it("allows retry for the latest failed attempt on a failed execution with a snapshot", () => {
    const result = evaluateStepRetryEligibility({
      execution: { status: PipelineExecutionStatus.FAILED, currentStepIndex: 0 },
      attempt: {
        id: "a1",
        stepId: "s1",
        status: StepExecutionStatus.FAILED,
        attemptNumber: 2,
        stepSnapshot: snapshot,
      },
      currentStepId: "s1",
      latestAttemptId: "a1",
      hasActiveAttempt: false,
    });
    expect(result).toEqual({ retryable: true, retryBlockedReason: null });
  });

  it("blocks retry when snapshot is missing", () => {
    const result = evaluateStepRetryEligibility({
      execution: { status: PipelineExecutionStatus.FAILED, currentStepIndex: 0 },
      attempt: {
        id: "a1",
        stepId: "s1",
        status: StepExecutionStatus.FAILED,
        attemptNumber: 1,
        stepSnapshot: null,
      },
      currentStepId: "s1",
      latestAttemptId: "a1",
      hasActiveAttempt: false,
    });
    expect(result.retryable).toBe(false);
    expect(result.retryBlockedReason).toBe("MISSING_STEP_SNAPSHOT");
  });

  it("blocks historical failed attempts that are not latest", () => {
    const result = evaluateStepRetryEligibility({
      execution: { status: PipelineExecutionStatus.FAILED, currentStepIndex: 0 },
      attempt: {
        id: "a1",
        stepId: "s1",
        status: StepExecutionStatus.FAILED,
        attemptNumber: 1,
        stepSnapshot: snapshot,
      },
      currentStepId: "s1",
      latestAttemptId: "a2",
      hasActiveAttempt: false,
    });
    expect(result.retryBlockedReason).toBe("NOT_LATEST_ATTEMPT");
  });
});
