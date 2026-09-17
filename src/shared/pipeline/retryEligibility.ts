import {
  PipelineExecutionStatus,
  StepAttemptKind,
  StepExecutionStatus,
  type PipelineExecution,
  type StepExecution,
} from "@db/client";
import { parseStepSnapshot } from "@/shared/pipeline/stepSnapshot.ts";

export type RetryBlockedReason =
  | "EXECUTION_NOT_FAILED"
  | "ATTEMPT_NOT_FAILED"
  | "NOT_CURRENT_STEP"
  | "NOT_LATEST_ATTEMPT"
  | "MISSING_STEP_SNAPSHOT"
  | "ACTIVE_ATTEMPT_EXISTS";

export type RetryEligibility = {
  retryable: boolean;
  retryBlockedReason: RetryBlockedReason | null;
};

export function evaluateStepRetryEligibility(args: {
  execution: Pick<PipelineExecution, "status" | "currentStepIndex">;
  attempt: Pick<StepExecution, "id" | "stepId" | "status" | "attemptNumber" | "stepSnapshot">;
  currentStepId: string | undefined;
  latestAttemptId: string | undefined;
  hasActiveAttempt: boolean;
}): RetryEligibility {
  const { execution, attempt, currentStepId, latestAttemptId, hasActiveAttempt } = args;

  if (execution.status !== PipelineExecutionStatus.FAILED) {
    return { retryable: false, retryBlockedReason: "EXECUTION_NOT_FAILED" };
  }
  if (attempt.status !== StepExecutionStatus.FAILED) {
    return { retryable: false, retryBlockedReason: "ATTEMPT_NOT_FAILED" };
  }
  if (!currentStepId || attempt.stepId !== currentStepId) {
    return { retryable: false, retryBlockedReason: "NOT_CURRENT_STEP" };
  }
  if (!latestAttemptId || attempt.id !== latestAttemptId) {
    return { retryable: false, retryBlockedReason: "NOT_LATEST_ATTEMPT" };
  }
  if (!parseStepSnapshot(attempt.stepSnapshot)) {
    return { retryable: false, retryBlockedReason: "MISSING_STEP_SNAPSHOT" };
  }
  if (hasActiveAttempt) {
    return { retryable: false, retryBlockedReason: "ACTIVE_ATTEMPT_EXISTS" };
  }

  return { retryable: true, retryBlockedReason: null };
}

export const ACTIVE_STEP_STATUSES: StepExecutionStatus[] = [
  StepExecutionStatus.PENDING,
  StepExecutionStatus.RUNNING,
];

export function isManualAttempt(kind: StepAttemptKind): boolean {
  return kind === StepAttemptKind.MANUAL;
}
