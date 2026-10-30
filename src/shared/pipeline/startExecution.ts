import { ConcurrencyPolicy, LogLevel, PipelineExecutionStatus } from "@db/client";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import type { PipelineJobMessage } from "@/services/worker/services/runners/pipeline.ts";
import { enqueueOutboxMessage, type OutboxTx } from "@/shared/pipeline/outbox.ts";

export type StartExecutionOptions = {
  triggeredBy: "scheduler" | "api" | "webhook" | "connector";
  context?: Record<string, unknown>;
  scheduleId?: string;
  scheduleInputContext?: Record<string, unknown>;
  /** Number of connectors that led here; set by the connector evaluator */
  chainDepth?: number;
};

export type StartExecutionResult = {
  executionId: string;
  skipped: boolean;
  skipReason?: string;
};

export const ACTIVE_EXECUTION_STATUSES = [
  PipelineExecutionStatus.PENDING,
  PipelineExecutionStatus.RUNNING,
  PipelineExecutionStatus.AWAITING_STEP,
];

/**
 * Create a PENDING execution and queue its first wake through the outbox, honouring the
 * pipeline's active flag and concurrency policy. Pass a transaction client to make the start
 * atomic with the caller's own writes (the connector evaluator does this).
 */
export async function startExecution(
  tx: OutboxTx,
  pipelineId: string,
  opts: StartExecutionOptions
): Promise<StartExecutionResult> {
  const pipeline = await tx.pipeline.findUnique({ where: { id: pipelineId } });

  if (!pipeline) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  if (!pipeline.isActive) {
    return { executionId: "", skipped: true, skipReason: "Pipeline is inactive" };
  }

  const activeExecution = await tx.pipelineExecution.findFirst({
    where: { pipelineId, status: { in: ACTIVE_EXECUTION_STATUSES } },
  });

  if (activeExecution) {
    if (pipeline.concurrencyPolicy === ConcurrencyPolicy.SKIP) {
      return {
        executionId: "",
        skipped: true,
        skipReason: `Active execution ${activeExecution.id} is already running (SKIP policy)`,
      };
    }

    if (pipeline.concurrencyPolicy === ConcurrencyPolicy.REPLACE) {
      await tx.pipelineExecution.update({
        where: { id: activeExecution.id },
        data: { status: PipelineExecutionStatus.CANCELLED, finishedAt: new Date() },
      });
      await tx.executionLog.create({
        data: {
          executionId: activeExecution.id,
          level: LogLevel.WARN,
          message: `Execution cancelled by REPLACE policy, superseded by new trigger from ${opts.triggeredBy}`,
          metadata: {},
        },
      });
    }
  }

  const now = new Date();
  const mergedContext = {
    ...(opts.scheduleInputContext ?? {}),
    ...(opts.context ?? {}),
    scheduledAt: now.toISOString(),
  };

  const execution = await tx.pipelineExecution.create({
    data: {
      pipelineId,
      scheduleId: opts.scheduleId,
      status: PipelineExecutionStatus.PENDING,
      triggeredBy: opts.triggeredBy,
      chainDepth: opts.chainDepth ?? 0,
      context: mergedContext as InputJsonValue,
    },
  });

  const msg: PipelineJobMessage = { executionId: execution.id };
  await enqueueOutboxMessage(tx, {
    destination: QUEUES.PIPELINE_EXECUTIONS,
    payload: { ...msg },
  });

  await tx.executionLog.create({
    data: {
      executionId: execution.id,
      level: LogLevel.INFO,
      message: `Pipeline triggered by ${opts.triggeredBy}`,
      metadata: {},
    },
  });

  return { executionId: execution.id, skipped: false };
}
