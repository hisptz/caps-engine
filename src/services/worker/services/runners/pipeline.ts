import {
  LogLevel,
  PipelineExecutionStatus,
  PrismaClient,
  StepAttemptKind,
  StepExecutionStatus,
  type Prisma,
} from "@db/client";
import type { Channel } from "amqplib";
import { StepRunner } from "./step";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { SpanStatusCode } from "@opentelemetry/api";
import { tracer, pipelineExecutionCounter } from "@/shared/telemetry/index.ts";
import { resolveStepQueueName } from "@/shared/handlers/catalog.ts";
import { logger } from "@/shared/utils";
import { enqueueOutboxMessage } from "@/shared/pipeline/outbox.ts";
import { snapshotFromPipelineStep } from "@/shared/pipeline/stepSnapshot.ts";

export const PIPELINE_QUEUE = "pipeline.executions";
export const STEP_RESULTS_QUEUE = "pipeline.step-results";

export interface CoordinatorDeps {
  prisma: PrismaClient;
  channel: Channel;
  stepRunner: StepRunner;
}

// Shape of a message on pipeline.executions
export interface PipelineJobMessage {
  executionId: string;
}

// Shape of a message on a step-specific queue
export interface StepJobMessage {
  executionId: string;
  stepExecutionId: string; // pre-created by coordinator so worker can update it
}

// Shape of a message on pipeline.step-results
export interface StepResultMessage {
  executionId: string;
  stepExecutionId: string;
  succeeded: boolean;
  skipped?: boolean;
  output?: unknown;
  errorMessage?: string;
}

// ============================================================
// Pipeline coordinator
// Handles one step per invocation, then either suspends or
// re-publishes itself (via outbox) to continue the pipeline.
// ============================================================

export class PipelineCoordinator {
  constructor(private deps: CoordinatorDeps) {}

  async handle(executionId: string): Promise<void> {
    const span = tracer.startSpan("caps.pipeline.coordinate", {
      attributes: { "caps.pipeline.execution_id": executionId },
    });

    try {
      await this._handle(executionId);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  }

  private async _handle(executionId: string): Promise<void> {
    const { prisma, stepRunner } = this.deps;
    const execution = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        pipeline: {
          include: {
            steps: { orderBy: { stepOrder: "asc" } },
          },
        },
      },
    });

    const steps = execution.pipeline.steps;
    const stepIndex = execution.currentStepIndex;

    // Honour pause/cancel: do nothing if the execution was stopped via API
    if (execution.status === PipelineExecutionStatus.PAUSED) {
      logger.info(`[coordinator] Execution is paused, skipping: ${executionId}`);
      return;
    }
    if (execution.status === PipelineExecutionStatus.CANCELLED) {
      logger.info(`[coordinator] Execution is cancelled, skipping: ${executionId}`);
      return;
    }
    // Terminal failure — only a retry command may revive this execution
    if (execution.status === PipelineExecutionStatus.FAILED) {
      logger.info(`[coordinator] Execution is failed, skipping: ${executionId}`);
      return;
    }
    // Duplicate wake while waiting on a queued step
    if (execution.status === PipelineExecutionStatus.AWAITING_STEP) {
      logger.info(`[coordinator] Execution is awaiting step, skipping: ${executionId}`);
      return;
    }
    if (execution.status === PipelineExecutionStatus.COMPLETED) {
      logger.info(`[coordinator] Execution is completed, skipping: ${executionId}`);
      return;
    }

    // Mark running on first step
    if (execution.status === PipelineExecutionStatus.PENDING) {
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { status: PipelineExecutionStatus.RUNNING, startedAt: new Date() },
      });
      await this.log(executionId, "INFO", `Pipeline started: ${execution.pipeline.name}`);
      logger.info(
        `[coordinator] Pipeline started executionId=${executionId} pipeline="${execution.pipeline.name}"`
      );
    }

    // All steps done
    if (stepIndex >= steps.length) {
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { status: PipelineExecutionStatus.COMPLETED, finishedAt: new Date() },
      });
      await this.log(executionId, "INFO", `Pipeline completed: ${execution.pipeline.name}`);
      logger.info(
        `[coordinator] Pipeline completed executionId=${executionId} pipeline="${execution.pipeline.name}"`
      );
      pipelineExecutionCounter.add(1, {
        "caps.pipeline.name": execution.pipeline.name,
        outcome: "succeeded",
      });
      return;
    }

    const step = steps[stepIndex]!;
    const context = execution.context as Record<string, unknown>;
    const input = stepIndex > 0 ? context[`step_${stepIndex - 1}_output`] : undefined;
    const queueName = resolveStepQueueName(step.handlerKey);

    // Resume a pre-created PENDING attempt (manual retry or crash recovery)
    const pendingAttempt = await prisma.stepExecution.findFirst({
      where: {
        executionId,
        stepId: step.id,
        status: StepExecutionStatus.PENDING,
      },
      orderBy: { attemptNumber: "desc" },
    });

    // --------------------------------------------------------
    // Queued step: dispatch and suspend
    // --------------------------------------------------------
    if (queueName) {
      await this.log(executionId, "INFO", `Dispatching step to queue: ${queueName}`);
      logger.info(
        `[coordinator] Dispatching step to queue executionId=${executionId} step="${step.name}" queue="${queueName}"`
      );

      const stepExecution =
        pendingAttempt ??
        (await prisma.stepExecution.create({
          data: {
            executionId,
            stepId: step.id,
            attemptNumber: await this.nextAttemptNumber(executionId, step.id),
            attemptKind: StepAttemptKind.AUTOMATIC,
            stepSnapshot: snapshotFromPipelineStep(step) as unknown as Prisma.InputJsonValue,
            input: input ? (input as object) : undefined,
            status: StepExecutionStatus.PENDING,
          },
        }));

      await enqueueOutboxMessage(prisma, {
        destination: queueName,
        payload: {
          executionId,
          stepExecutionId: stepExecution.id,
        } satisfies StepJobMessage,
      });

      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { status: PipelineExecutionStatus.AWAITING_STEP },
      });

      return;
    }

    // --------------------------------------------------------
    // Inline step: run directly, then continue
    // --------------------------------------------------------
    await this.log(executionId, "INFO", `Running inline step: ${step.name}`);
    logger.info(`[coordinator] Running inline step executionId=${executionId} step="${step.name}"`);

    if (pendingAttempt) {
      const result = await stepRunner.runExisting(execution, pendingAttempt.id, step);
      if (!result.succeeded) {
        await this.failExecution(executionId, execution.pipeline.name, step.name);
        return;
      }
      await this.finishInlineSuccess(executionId, stepIndex, result.output, context);
      return;
    }

    // Automatic attempts respect maxRetries; MANUAL is a single shot via pendingAttempt path
    let attempt = 1;
    let succeeded = false;
    let stepOutput: unknown;

    while (attempt <= step.maxRetries + 1) {
      if (attempt > 1) {
        const delay = step.retryDelayMs * Math.pow(2, attempt - 2);
        await Bun.sleep(delay);
        await this.log(executionId, "WARN", `Retrying step: ${step.name} (attempt ${attempt})`);
        logger.warn(
          `[coordinator] Retrying inline step executionId=${executionId} step="${step.name}" attempt=${attempt}`
        );
      }

      const freshExecution = await prisma.pipelineExecution.findUniqueOrThrow({
        where: { id: executionId },
      });
      if (
        freshExecution.status === PipelineExecutionStatus.CANCELLED ||
        freshExecution.status === PipelineExecutionStatus.PAUSED
      ) {
        logger.info(
          `[coordinator] Execution ${freshExecution.status.toLowerCase()} during inline step, aborting: ${executionId}`
        );
        return;
      }

      const result = await stepRunner.run(step, freshExecution, attempt, input);

      if (result.succeeded) {
        succeeded = true;
        stepOutput = result.output;
        break;
      }

      attempt++;
    }

    if (!succeeded) {
      await this.failExecution(executionId, execution.pipeline.name, step.name);
      return;
    }

    await this.finishInlineSuccess(executionId, stepIndex, stepOutput, context);
  }

  private async finishInlineSuccess(
    executionId: string,
    stepIndex: number,
    stepOutput: unknown,
    context: Record<string, unknown>
  ): Promise<void> {
    const { prisma } = this.deps;
    const afterInline = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: { status: true },
    });
    if (
      afterInline.status === PipelineExecutionStatus.CANCELLED ||
      afterInline.status === PipelineExecutionStatus.PAUSED
    ) {
      logger.info(
        `[coordinator] Execution ${afterInline.status.toLowerCase()} during inline step, skipping cursor advance: ${executionId}`
      );
      return;
    }
    logger.info(
      `[coordinator] Cursor advanced executionId=${executionId} completedStepIndex=${stepIndex} nextStepIndex=${stepIndex + 1}`
    );
    await this.advanceCursor(executionId, stepIndex, stepOutput, context);
    await this.enqueuePipelineWake(executionId);
  }

  private async failExecution(
    executionId: string,
    pipelineName: string,
    stepName: string
  ): Promise<void> {
    await this.log(executionId, "ERROR", `Step exhausted retries: ${stepName}`);
    logger.error(
      `[coordinator] Inline step exhausted retries executionId=${executionId} step="${stepName}"`
    );
    await this.deps.prisma.pipelineExecution.update({
      where: { id: executionId },
      data: { status: PipelineExecutionStatus.FAILED, finishedAt: new Date() },
    });
    pipelineExecutionCounter.add(1, {
      "caps.pipeline.name": pipelineName,
      outcome: "failed",
    });
  }

  // Called by the step-results consumer when a queued step finishes
  async handleStepResult(msg: StepResultMessage): Promise<void> {
    const { prisma } = this.deps;
    const { executionId, stepExecutionId, succeeded, output, errorMessage } = msg;
    logger.info(
      `[coordinator] Step result received executionId=${executionId} stepExecutionId=${stepExecutionId} succeeded=${succeeded}`
    );

    // Once-only processing: claim this attempt's result
    const claimed = await prisma.stepExecution.updateMany({
      where: {
        id: stepExecutionId,
        resultProcessedAt: null,
        status: {
          in: [
            StepExecutionStatus.SUCCEEDED,
            StepExecutionStatus.FAILED,
            StepExecutionStatus.SKIPPED,
          ],
        },
      },
      data: { resultProcessedAt: new Date() },
    });

    if (claimed.count === 0) {
      logger.info(
        `[coordinator] Ignoring duplicate/stale step result executionId=${executionId} stepExecutionId=${stepExecutionId}`
      );
      return;
    }

    const stepExecution = await prisma.stepExecution.findUniqueOrThrow({
      where: { id: stepExecutionId },
    });

    const execution = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        pipeline: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
      },
    });

    const step = execution.pipeline.steps[execution.currentStepIndex];
    if (!step || step.id !== stepExecution.stepId) {
      logger.warn(
        `[coordinator] Step result does not match current cursor executionId=${executionId} stepExecutionId=${stepExecutionId}`
      );
      return;
    }

    const context = execution.context as Record<string, unknown>;

    // Ignore results for cancelled executions — do not advance or retry
    if (execution.status === PipelineExecutionStatus.CANCELLED) {
      logger.info(`[coordinator] Execution cancelled, ignoring step result: ${executionId}`);
      return;
    }

    if (!succeeded) {
      const attempts = await prisma.stepExecution.count({
        where: { executionId, stepId: step.id },
      });

      // Manual attempts never receive an automatic retry budget
      const mayAutoRetry =
        stepExecution.attemptKind === StepAttemptKind.AUTOMATIC && attempts <= step.maxRetries;

      if (mayAutoRetry) {
        await this.log(
          executionId,
          "WARN",
          `Re-dispatching step: ${step.name} (attempt ${attempts + 1})`
        );
        logger.warn(
          `[coordinator] Re-dispatching queued step executionId=${executionId} step="${step.name}" attempt=${attempts + 1}`
        );

        const delay = step.retryDelayMs * Math.pow(2, attempts - 1);
        await Bun.sleep(delay);

        const retryExecution = await prisma.stepExecution.create({
          data: {
            executionId,
            stepId: step.id,
            attemptNumber: attempts + 1,
            attemptKind: StepAttemptKind.AUTOMATIC,
            stepSnapshot: snapshotFromPipelineStep(step) as unknown as Prisma.InputJsonValue,
            input: context[`step_${execution.currentStepIndex - 1}_output`]
              ? (context[`step_${execution.currentStepIndex - 1}_output`] as object)
              : undefined,
            status: StepExecutionStatus.PENDING,
          },
        });

        const retryQueueName = resolveStepQueueName(step.handlerKey);
        if (!retryQueueName) {
          return;
        }

        await enqueueOutboxMessage(prisma, {
          destination: retryQueueName,
          payload: {
            executionId,
            stepExecutionId: retryExecution.id,
          } satisfies StepJobMessage,
        });
        return;
      }

      // No retries left (or manual attempt failed)
      await this.log(
        executionId,
        "ERROR",
        `Queued step exhausted retries: ${step.name}. ${errorMessage ?? ""}`
      );
      logger.error(
        `[coordinator] Queued step exhausted retries executionId=${executionId} step="${step.name}" error="${errorMessage ?? ""}"`
      );
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { status: PipelineExecutionStatus.FAILED, finishedAt: new Date() },
      });
      pipelineExecutionCounter.add(1, {
        "caps.pipeline.name": execution.pipeline.name,
        outcome: "failed",
      });
      return;
    }

    // Step succeeded — advance cursor and wake the coordinator (unless paused via API)
    logger.info(
      `[coordinator] Queued step succeeded, cursor advanced executionId=${executionId} completedStepIndex=${execution.currentStepIndex}`
    );
    await this.advanceCursor(executionId, execution.currentStepIndex, output, context);
    const afterQueued = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: { status: true },
    });
    if (
      afterQueued.status !== PipelineExecutionStatus.PAUSED &&
      afterQueued.status !== PipelineExecutionStatus.CANCELLED
    ) {
      await this.enqueuePipelineWake(executionId);
    }
  }

  // --------------------------------------------------------
  // Helpers
  // --------------------------------------------------------

  private async advanceCursor(
    executionId: string,
    stepIndex: number,
    output: unknown,
    context: Record<string, unknown>
  ): Promise<void> {
    await this.deps.prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        currentStepIndex: stepIndex + 1,
        status: PipelineExecutionStatus.RUNNING,
        context: {
          ...context,
          [`step_${stepIndex}_output`]: output ?? null,
        } as InputJsonValue,
      },
    });
  }

  private async enqueuePipelineWake(executionId: string): Promise<void> {
    await enqueueOutboxMessage(this.deps.prisma, {
      destination: PIPELINE_QUEUE,
      payload: { executionId } satisfies PipelineJobMessage,
    });
  }

  private async nextAttemptNumber(executionId: string, stepId: string): Promise<number> {
    const count = await this.deps.prisma.stepExecution.count({
      where: { executionId, stepId },
    });
    return count + 1;
  }

  private async log(
    executionId: string,
    level: "INFO" | "WARN" | "ERROR",
    message: string
  ): Promise<void> {
    await this.deps.prisma.executionLog.create({
      data: { executionId, level: level as LogLevel, message, metadata: {} },
    });
  }
}
