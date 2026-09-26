import { PrismaClient, StepExecutionStatus, LogLevel, PipelineExecutionStatus } from "@db/client";
import type { Channel } from "amqplib";
import { resolveHandler, StepSkippedError } from "@/services/worker/types/service.ts";
import { logger } from "@/shared/utils";
import {
  STEP_RESULTS_QUEUE,
  type StepJobMessage,
  type StepResultMessage,
} from "@/services/worker/services/runners/pipeline.ts";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { createTaskReporter, errorColumns } from "@/services/worker/services/runners/step.ts";
import { resolveEffectiveHandlerConfig } from "@/services/worker/utils/resolveEffectiveHandlerConfig.ts";
import {
  parseStepSnapshot,
  pipelineStepFromSnapshot,
  snapshotFromPipelineStep,
} from "@/shared/pipeline/stepSnapshot.ts";
import { enqueueOutboxMessage } from "@/shared/pipeline/outbox.ts";

// ============================================================
// Step worker — executes a single queued step and publishes
// the result back to pipeline.step-results via the outbox
// ============================================================

export interface StepWorkerDeps {
  prisma: PrismaClient;
  channel: Channel;
}

export class StepWorker {
  constructor(private deps: StepWorkerDeps) {}

  async handle(msg: StepJobMessage): Promise<void> {
    const { prisma } = this.deps;
    const { executionId, stepExecutionId } = msg;

    const stepExecution = await prisma.stepExecution.findUnique({
      where: { id: stepExecutionId },
      include: { step: true },
    });

    const execution = stepExecution
      ? await prisma.pipelineExecution.findUnique({ where: { id: executionId } })
      : null;

    if (!stepExecution || !execution) {
      logger.info(
        `[step-worker] Skipping job for deleted execution executionId=${executionId} stepExecutionId=${stepExecutionId}`
      );
      return;
    }

    if (
      execution.status === PipelineExecutionStatus.CANCELLED ||
      execution.status === PipelineExecutionStatus.PAUSED ||
      execution.status === PipelineExecutionStatus.FAILED ||
      execution.status === PipelineExecutionStatus.COMPLETED
    ) {
      logger.info(
        `[step-worker] Skipping job for non-active execution status=${execution.status} executionId=${executionId} stepExecutionId=${stepExecutionId}`
      );
      return;
    }

    // Exact-attempt claim: PENDING → RUNNING (duplicate deliveries are no-ops)
    if (stepExecution.status === StepExecutionStatus.PENDING) {
      const claimed = await prisma.stepExecution.updateMany({
        where: { id: stepExecutionId, status: StepExecutionStatus.PENDING },
        data: { status: StepExecutionStatus.RUNNING, startedAt: new Date() },
      });
      if (claimed.count === 0) {
        const current = await prisma.stepExecution.findUniqueOrThrow({
          where: { id: stepExecutionId },
        });
        if (current.status !== StepExecutionStatus.RUNNING) {
          logger.info(
            `[step-worker] Attempt already terminal status=${current.status} stepExecutionId=${stepExecutionId}`
          );
          return;
        }
      }
    } else if (stepExecution.status !== StepExecutionStatus.RUNNING) {
      logger.info(
        `[step-worker] Ignoring non-runnable attempt status=${stepExecution.status} stepExecutionId=${stepExecutionId}`
      );
      return;
    }

    const snapshot =
      parseStepSnapshot(stepExecution.stepSnapshot) ?? snapshotFromPipelineStep(stepExecution.step);
    const step = pipelineStepFromSnapshot(snapshot);
    const context = execution.context as Record<string, unknown>;
    const input = stepExecution.input;
    const startMs = Date.now();

    logger.info(
      `[step-worker] Picked up job executionId=${executionId} stepExecutionId=${stepExecutionId} step="${step.name}"`
    );
    await this.log(executionId, stepExecutionId, "INFO", `Step worker executing: ${step.name}`);

    try {
      const handler = resolveHandler(step.handlerKey);
      const tasks = createTaskReporter(prisma, stepExecution);

      const handlerConfig = resolveEffectiveHandlerConfig({
        handlerKey: step.handlerKey,
        handlerConfig: step.handlerConfig as Record<string, unknown> | null,
        pipelineContext: context,
        stepId: step.id,
      });

      const ctx = {
        step,
        stepExecution,
        pipelineContext: context,
        input,
        handlerConfig,
        log: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, metadata = {}) =>
          this.log(executionId, stepExecutionId, level, message, metadata),
        tasks,
      };

      const output = await handler.execute(ctx);

      await prisma.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: StepExecutionStatus.SUCCEEDED,
          output: output ? (output as object) : undefined,
          finishedAt: new Date(),
        },
      });

      await enqueueOutboxMessage(prisma, {
        destination: STEP_RESULTS_QUEUE,
        payload: {
          executionId,
          stepExecutionId,
          succeeded: true,
          output,
        } satisfies StepResultMessage,
      });
      logger.info(
        `[step-worker] Step succeeded executionId=${executionId} stepExecutionId=${stepExecutionId} step="${step.name}" durationMs=${Date.now() - startMs}`
      );
    } catch (error) {
      if (error instanceof StepSkippedError) {
        await this.log(executionId, stepExecutionId, "INFO", `Step skipped: ${step.name}`, {
          reason: error.message,
        });

        await prisma.stepExecution.update({
          where: { id: stepExecutionId },
          data: {
            status: StepExecutionStatus.SKIPPED,
            output: error.output ? (error.output as object) : undefined,
            finishedAt: new Date(),
          },
        });

        await enqueueOutboxMessage(prisma, {
          destination: STEP_RESULTS_QUEUE,
          payload: {
            executionId,
            stepExecutionId,
            succeeded: true,
            skipped: true,
            output: error.output,
          } satisfies StepResultMessage,
        });
        logger.info(
          `[step-worker] Step skipped executionId=${executionId} stepExecutionId=${stepExecutionId} step="${step.name}" reason="${error.message}" durationMs=${Date.now() - startMs}`
        );
        return;
      }

      const err = error instanceof Error ? error : new Error(String(error));

      await this.log(executionId, stepExecutionId, "ERROR", `Step worker failed: ${step.name}`, {
        error: err.message,
      });

      await prisma.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: StepExecutionStatus.FAILED,
          ...errorColumns(err),
          finishedAt: new Date(),
        },
      });

      await enqueueOutboxMessage(prisma, {
        destination: STEP_RESULTS_QUEUE,
        payload: {
          executionId,
          stepExecutionId,
          succeeded: false,
          errorMessage: errorColumns(err).errorMessage,
        } satisfies StepResultMessage,
      });
      logger.error(
        `[step-worker] Step failed executionId=${executionId} stepExecutionId=${stepExecutionId} step="${step.name}" error="${err.message}" durationMs=${Date.now() - startMs}`
      );
    }
  }

  private async log(
    executionId: string,
    stepExecutionId: string,
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.deps.prisma.executionLog.create({
      data: {
        executionId,
        stepExecutionId,
        level: level as LogLevel,
        message,
        metadata: metadata as InputJsonValue,
      },
    });
  }
}
