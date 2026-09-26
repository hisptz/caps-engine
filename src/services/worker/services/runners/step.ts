import type { PipelineExecution, PipelineStep, StepExecution } from "@db/client";
import {
  LogLevel,
  PrismaClient,
  StepAttemptKind,
  StepExecutionStatus,
  TaskExecutionStatus,
  type Prisma,
} from "@db/client";
import {
  resolveHandler,
  StepSkippedError,
  type StepContext,
  type TaskHandle,
  type TaskReporter,
} from "@/services/worker/types/service.ts";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { SpanStatusCode } from "@opentelemetry/api";
import { tracer, stepExecutionCounter, stepDurationHistogram } from "@/shared/telemetry/index.ts";
import { logger } from "@/shared/utils";
import { toErrorRecord } from "@/shared/utils/error.ts";
import { resolveEffectiveHandlerConfig } from "@/services/worker/utils/resolveEffectiveHandlerConfig.ts";
import {
  parseStepSnapshot,
  pipelineStepFromSnapshot,
  snapshotFromPipelineStep,
  type StepDefinitionSnapshot,
} from "@/shared/pipeline/stepSnapshot.ts";

export interface StepRunnerDeps {
  prisma: PrismaClient;
}

export interface StepRunResult {
  succeeded: boolean;
  skipped?: boolean;
  output?: unknown;
  error?: Error;
  stepExecutionId?: string;
}

// ============================================================
// Task reporter — builds TaskHandle instances for each sub-task
// ============================================================

export function createTaskReporter(
  prisma: PrismaClient,
  stepExecution: StepExecution
): TaskReporter {
  let taskOrder = 0;

  return {
    async startTask(name, input): Promise<TaskHandle> {
      const order = taskOrder++;

      const taskExecution = await prisma.taskExecution.create({
        data: {
          stepExecutionId: stepExecution.id,
          name,
          taskOrder: order,
          status: TaskExecutionStatus.RUNNING,
          input: input ? (input as object) : undefined,
          startedAt: new Date(),
        },
      });

      return {
        taskExecution,

        async log(level, message, metadata = {}) {
          await prisma.executionLog.create({
            data: {
              executionId: stepExecution.executionId,
              stepExecutionId: stepExecution.id,
              taskExecutionId: taskExecution.id,
              level: level as LogLevel,
              message,
              metadata: metadata as InputJsonValue,
            },
          });
        },

        async succeed(output) {
          await prisma.taskExecution.update({
            where: { id: taskExecution.id },
            data: {
              status: TaskExecutionStatus.SUCCEEDED,
              output: output ? (output as object) : undefined,
              finishedAt: new Date(),
            },
          });
        },

        async fail(error) {
          await prisma.taskExecution.update({
            where: { id: taskExecution.id },
            data: {
              status: TaskExecutionStatus.FAILED,
              ...errorColumns(error),
              finishedAt: new Date(),
            },
          });
        },
      };
    },
  };
}

export function errorColumns(err: Error) {
  const { errorMessage, errorStack, errorDetails } = toErrorRecord(err);
  return { errorMessage, errorStack, errorDetails: errorDetails as InputJsonValue | undefined };
}

function createStepLogger(
  prisma: PrismaClient,
  execution: PipelineExecution,
  stepExecution: StepExecution
) {
  return async function log(
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await prisma.executionLog.create({
      data: {
        executionId: execution.id,
        stepExecutionId: stepExecution.id,
        level: level as LogLevel,
        message,
        metadata: metadata as InputJsonValue,
      },
    });
  };
}

function resolveStepDefinition(
  stepExecution: StepExecution,
  fallbackStep?: PipelineStep
): { step: PipelineStep; snapshot: StepDefinitionSnapshot } {
  const fromSnapshot = parseStepSnapshot(stepExecution.stepSnapshot);
  if (fromSnapshot) {
    return { step: pipelineStepFromSnapshot(fromSnapshot), snapshot: fromSnapshot };
  }
  if (fallbackStep) {
    return { step: fallbackStep, snapshot: snapshotFromPipelineStep(fallbackStep) };
  }
  throw new Error(`Step execution ${stepExecution.id} has no usable step snapshot`);
}

// ============================================================
// Step runner — orchestrates a single step attempt
// ============================================================

export class StepRunner {
  constructor(private deps: StepRunnerDeps) {}

  /**
   * Create a new AUTOMATIC attempt (with snapshot) and execute it inline.
   * Used by the coordinator for inline (non-queued) handlers.
   */
  async run(
    step: PipelineStep,
    execution: PipelineExecution,
    attemptNumber: number,
    input: unknown
  ): Promise<StepRunResult> {
    const { prisma } = this.deps;
    const snapshot = snapshotFromPipelineStep(step);

    const stepExecution = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        status: StepExecutionStatus.RUNNING,
        attemptNumber,
        attemptKind: StepAttemptKind.AUTOMATIC,
        stepSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        input: input ? (input as object) : undefined,
        startedAt: new Date(),
      },
    });

    return this.executeAttempt(execution, stepExecution, step);
  }

  /** Execute a pre-created attempt using its immutable snapshot. */
  async runExisting(
    execution: PipelineExecution,
    stepExecutionId: string,
    fallbackStep?: PipelineStep
  ): Promise<StepRunResult> {
    const { prisma } = this.deps;
    const stepExecution = await prisma.stepExecution.findUniqueOrThrow({
      where: { id: stepExecutionId },
    });

    // Claim PENDING → RUNNING (idempotent if already RUNNING)
    if (stepExecution.status === StepExecutionStatus.PENDING) {
      const claimed = await prisma.stepExecution.updateMany({
        where: { id: stepExecutionId, status: StepExecutionStatus.PENDING },
        data: { status: StepExecutionStatus.RUNNING, startedAt: new Date() },
      });
      if (claimed.count === 0) {
        const current = await prisma.stepExecution.findUniqueOrThrow({
          where: { id: stepExecutionId },
        });
        if (
          current.status === StepExecutionStatus.SUCCEEDED ||
          current.status === StepExecutionStatus.SKIPPED ||
          current.status === StepExecutionStatus.FAILED
        ) {
          return {
            succeeded: current.status !== StepExecutionStatus.FAILED,
            skipped: current.status === StepExecutionStatus.SKIPPED,
            output: current.output,
            stepExecutionId,
          };
        }
      }
    } else if (
      stepExecution.status === StepExecutionStatus.SUCCEEDED ||
      stepExecution.status === StepExecutionStatus.SKIPPED ||
      stepExecution.status === StepExecutionStatus.FAILED
    ) {
      return {
        succeeded: stepExecution.status !== StepExecutionStatus.FAILED,
        skipped: stepExecution.status === StepExecutionStatus.SKIPPED,
        output: stepExecution.output,
        stepExecutionId,
      };
    }

    const refreshed = await prisma.stepExecution.findUniqueOrThrow({
      where: { id: stepExecutionId },
    });
    return this.executeAttempt(execution, refreshed, fallbackStep);
  }

  private async executeAttempt(
    execution: PipelineExecution,
    stepExecution: StepExecution,
    fallbackStep?: PipelineStep
  ): Promise<StepRunResult> {
    const { prisma } = this.deps;
    const { step } = resolveStepDefinition(stepExecution, fallbackStep);
    const attemptNumber = stepExecution.attemptNumber;

    const span = tracer.startSpan(`caps.step`, {
      attributes: {
        "caps.step.name": step.name,
        "caps.step.handler_key": step.handlerKey,
        "caps.step.attempt": attemptNumber,
        "caps.pipeline.execution_id": execution.id,
      },
    });

    const startMs = Date.now();

    try {
      const log = createStepLogger(prisma, execution, stepExecution);
      const tasks = createTaskReporter(prisma, stepExecution);

      await log("INFO", `Starting step: ${step.name} (attempt ${attemptNumber})`);
      logger.info(
        `[step-runner] Starting step="${step.name}" executionId=${execution.id} stepExecutionId=${stepExecution.id} attempt=${attemptNumber}`
      );

      try {
        const handler = resolveHandler(step.handlerKey);
        const pipelineContext = execution.context as Record<string, unknown>;
        const handlerConfig = resolveEffectiveHandlerConfig({
          handlerKey: step.handlerKey,
          handlerConfig: step.handlerConfig as Record<string, unknown> | null,
          pipelineContext,
          stepId: step.id,
        });

        const ctx: StepContext = {
          step,
          stepExecution,
          pipelineContext,
          input: stepExecution.input,
          handlerConfig,
          log,
          tasks,
        };

        const output = await handler.execute(ctx);

        await prisma.stepExecution.update({
          where: { id: stepExecution.id },
          data: {
            status: StepExecutionStatus.SUCCEEDED,
            output: output ? (output as object) : undefined,
            finishedAt: new Date(),
          },
        });

        await log("INFO", `Step succeeded: ${step.name}`);
        logger.info(
          `[step-runner] Step succeeded step="${step.name}" executionId=${execution.id} stepExecutionId=${stepExecution.id} durationMs=${Date.now() - startMs}`
        );

        stepExecutionCounter.add(1, {
          "caps.step.handler_key": step.handlerKey,
          outcome: "succeeded",
        });
        stepDurationHistogram.record(Date.now() - startMs, {
          "caps.step.handler_key": step.handlerKey,
          outcome: "succeeded",
        });
        span.setStatus({ code: SpanStatusCode.OK });

        return { succeeded: true, output, stepExecutionId: stepExecution.id };
      } catch (error) {
        if (error instanceof StepSkippedError) {
          await prisma.stepExecution.update({
            where: { id: stepExecution.id },
            data: {
              status: StepExecutionStatus.SKIPPED,
              output: error.output ? (error.output as object) : undefined,
              finishedAt: new Date(),
            },
          });

          await log("INFO", `Step skipped: ${step.name}`, { reason: error.message });
          logger.info(
            `[step-runner] Step skipped step="${step.name}" executionId=${execution.id} stepExecutionId=${stepExecution.id} reason="${error.message}"`
          );

          stepExecutionCounter.add(1, {
            "caps.step.handler_key": step.handlerKey,
            outcome: "skipped",
          });
          stepDurationHistogram.record(Date.now() - startMs, {
            "caps.step.handler_key": step.handlerKey,
            outcome: "skipped",
          });
          span.setStatus({ code: SpanStatusCode.OK });

          return {
            succeeded: true,
            skipped: true,
            output: error.output,
            stepExecutionId: stepExecution.id,
          };
        }

        const err = error instanceof Error ? error : new Error(String(error));

        await log("ERROR", `Step failed: ${step.name}`, {
          error: err.message,
          stack: err.stack,
          attempt: attemptNumber,
        });
        logger.error(
          `[step-runner] Step failed step="${step.name}" executionId=${execution.id} stepExecutionId=${stepExecution.id} attempt=${attemptNumber} error="${err.message}"`
        );

        await prisma.stepExecution.update({
          where: { id: stepExecution.id },
          data: {
            status: StepExecutionStatus.FAILED,
            ...errorColumns(err),
            finishedAt: new Date(),
          },
        });

        stepExecutionCounter.add(1, {
          "caps.step.handler_key": step.handlerKey,
          outcome: "failed",
        });
        stepDurationHistogram.record(Date.now() - startMs, {
          "caps.step.handler_key": step.handlerKey,
          outcome: "failed",
        });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

        return { succeeded: false, error: err, stepExecutionId: stepExecution.id };
      }
    } finally {
      span.end();
    }
  }
}
