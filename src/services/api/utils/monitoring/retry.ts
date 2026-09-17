import {
  LogLevel,
  PipelineExecutionStatus,
  Prisma,
  PrismaClient,
  StepAttemptKind,
  StepExecutionStatus,
  StepRetryCommandStatus,
} from "@db/client";
import { resolveStepQueueName } from "@/shared/handlers/catalog.ts";
import { enqueueOutboxMessage } from "@/shared/pipeline/outbox.ts";
import {
  ACTIVE_STEP_STATUSES,
  evaluateStepRetryEligibility,
} from "@/shared/pipeline/retryEligibility.ts";
import { parseStepSnapshot } from "@/shared/pipeline/stepSnapshot.ts";
import {
  PIPELINE_QUEUE,
  type PipelineJobMessage,
  type StepJobMessage,
} from "@/services/worker/services/runners/pipeline.ts";

export class StepRetryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "StepRetryError";
  }
}

export type RetryStepExecutionResult = {
  executionId: string;
  sourceStepExecutionId: string;
  replacementStepExecutionId: string;
  retryCommandId: string;
  status: "ACCEPTED";
  reused: boolean;
};

export class StepRetryService {
  constructor(private prisma: PrismaClient) {}

  async retryStepExecution(
    stepExecutionId: string,
    idempotencyKey: string
  ): Promise<RetryStepExecutionResult> {
    // Fast path: existing idempotent command
    const existing = await this.prisma.stepRetryCommand.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.sourceStepExecutionId !== stepExecutionId) {
        throw new StepRetryError(
          "Idempotency key already used for a different step execution",
          409,
          "IDEMPOTENCY_KEY_CONFLICT"
        );
      }
      return {
        executionId: existing.executionId,
        sourceStepExecutionId: existing.sourceStepExecutionId,
        replacementStepExecutionId: existing.replacementStepExecutionId,
        retryCommandId: existing.id,
        status: "ACCEPTED",
        reused: true,
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const source = await tx.stepExecution.findUnique({
          where: { id: stepExecutionId },
          include: {
            execution: {
              include: {
                pipeline: {
                  include: { steps: { orderBy: { stepOrder: "asc" } } },
                },
              },
            },
            step: true,
          },
        });

        if (!source) {
          throw new StepRetryError("Step execution not found", 404, "NOT_FOUND");
        }

        const execution = source.execution;
        const currentStep = execution.pipeline.steps[execution.currentStepIndex];
        const attemptsForStep = await tx.stepExecution.findMany({
          where: { executionId: execution.id, stepId: source.stepId },
          orderBy: { attemptNumber: "asc" },
        });
        const latestAttempt = attemptsForStep.at(-1);
        const hasActiveAttempt = attemptsForStep.some((a) =>
          ACTIVE_STEP_STATUSES.includes(a.status)
        );

        const eligibility = evaluateStepRetryEligibility({
          execution,
          attempt: source,
          currentStepId: currentStep?.id,
          latestAttemptId: latestAttempt?.id,
          hasActiveAttempt,
        });

        if (!eligibility.retryable) {
          throw new StepRetryError(
            `Step execution is not retryable (${eligibility.retryBlockedReason})`,
            409,
            eligibility.retryBlockedReason ?? "NOT_RETRYABLE"
          );
        }

        const snapshot = parseStepSnapshot(source.stepSnapshot);
        if (!snapshot) {
          throw new StepRetryError(
            "Step execution is missing an original definition snapshot",
            409,
            "MISSING_STEP_SNAPSHOT"
          );
        }

        const nextAttemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
        const queueName = resolveStepQueueName(snapshot.handlerKey);
        const nextStatus = queueName
          ? PipelineExecutionStatus.AWAITING_STEP
          : PipelineExecutionStatus.RUNNING;

        // Revive the same execution without clearing context/cursor/history
        await tx.pipelineExecution.update({
          where: { id: execution.id },
          data: {
            status: nextStatus,
            finishedAt: null,
          },
        });

        const replacement = await tx.stepExecution.create({
          data: {
            executionId: execution.id,
            stepId: source.stepId,
            attemptNumber: nextAttemptNumber,
            attemptKind: StepAttemptKind.MANUAL,
            status: StepExecutionStatus.PENDING,
            stepSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            input: source.input === null ? undefined : (source.input as object),
          },
        });

        const command = await tx.stepRetryCommand.create({
          data: {
            executionId: execution.id,
            sourceStepExecutionId: source.id,
            replacementStepExecutionId: replacement.id,
            idempotencyKey,
            status: StepRetryCommandStatus.DISPATCHED,
          },
        });

        if (queueName) {
          await enqueueOutboxMessage(tx, {
            destination: queueName,
            payload: {
              executionId: execution.id,
              stepExecutionId: replacement.id,
            } satisfies StepJobMessage,
          });
        } else {
          await enqueueOutboxMessage(tx, {
            destination: PIPELINE_QUEUE,
            payload: { executionId: execution.id } satisfies PipelineJobMessage,
          });
        }

        await tx.executionLog.create({
          data: {
            executionId: execution.id,
            stepExecutionId: replacement.id,
            level: LogLevel.INFO,
            message: `Manual retry accepted for step "${snapshot.name}" (attempt ${nextAttemptNumber})`,
            metadata: {
              action: "step_retry",
              sourceStepExecutionId: source.id,
              replacementStepExecutionId: replacement.id,
              retryCommandId: command.id,
              idempotencyKey,
            },
          },
        });

        return {
          executionId: execution.id,
          sourceStepExecutionId: source.id,
          replacementStepExecutionId: replacement.id,
          retryCommandId: command.id,
          status: "ACCEPTED" as const,
          reused: false,
        };
      });
    } catch (err) {
      if (err instanceof StepRetryError) throw err;

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Concurrent insert on idempotencyKey or sourceStepExecutionId
        const raced = await this.prisma.stepRetryCommand.findUnique({
          where: { idempotencyKey },
        });
        if (raced && raced.sourceStepExecutionId === stepExecutionId) {
          return {
            executionId: raced.executionId,
            sourceStepExecutionId: raced.sourceStepExecutionId,
            replacementStepExecutionId: raced.replacementStepExecutionId,
            retryCommandId: raced.id,
            status: "ACCEPTED",
            reused: true,
          };
        }

        const bySource = await this.prisma.stepRetryCommand.findUnique({
          where: { sourceStepExecutionId: stepExecutionId },
        });
        if (bySource) {
          return {
            executionId: bySource.executionId,
            sourceStepExecutionId: bySource.sourceStepExecutionId,
            replacementStepExecutionId: bySource.replacementStepExecutionId,
            retryCommandId: bySource.id,
            status: "ACCEPTED",
            reused: true,
          };
        }

        throw new StepRetryError(
          "A retry is already in progress for this step execution",
          409,
          "RETRY_IN_PROGRESS"
        );
      }

      throw err;
    }
  }
}
