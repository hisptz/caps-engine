import {
  ConcurrencyPolicy,
  LogLevel,
  PipelineExecutionStatus,
  type PrismaClient,
} from "@db/client";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import type { PipelineJobMessage } from "@/services/worker/services/runners/pipeline.ts";
import { enqueueOutboxMessage } from "@/shared/pipeline/outbox.ts";

export type TriggerOptions = {
  triggeredBy: "scheduler" | "api" | "webhook";
  context?: Record<string, unknown>;
  scheduleId?: string;
  scheduleInputContext?: Record<string, unknown>;
};

export type TriggerResult = {
  executionId: string;
  skipped: boolean;
  skipReason?: string;
};

const ACTIVE_STATUSES = [
  PipelineExecutionStatus.PENDING,
  PipelineExecutionStatus.RUNNING,
  PipelineExecutionStatus.AWAITING_STEP,
];

export class TriggerService {
  constructor(private prisma: PrismaClient) {}

  async triggerPipeline(pipelineId: string, opts: TriggerOptions): Promise<TriggerResult> {
    const pipeline = await this.prisma.pipeline.findUnique({ where: { id: pipelineId } });

    if (!pipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }

    if (!pipeline.isActive) {
      return { executionId: "", skipped: true, skipReason: "Pipeline is inactive" };
    }

    const activeExecution = await this.prisma.pipelineExecution.findFirst({
      where: { pipelineId, status: { in: ACTIVE_STATUSES } },
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
        await this.prisma.pipelineExecution.update({
          where: { id: activeExecution.id },
          data: { status: PipelineExecutionStatus.CANCELLED, finishedAt: new Date() },
        });
        await this.prisma.executionLog.create({
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

    const execution = await this.prisma.pipelineExecution.create({
      data: {
        pipelineId,
        scheduleId: opts.scheduleId,
        status: PipelineExecutionStatus.PENDING,
        triggeredBy: opts.triggeredBy,
        context: mergedContext as InputJsonValue,
      },
    });

    const msg: PipelineJobMessage = { executionId: execution.id };
    await enqueueOutboxMessage(this.prisma, {
      destination: QUEUES.PIPELINE_EXECUTIONS,
      payload: { ...msg },
    });

    await this.prisma.executionLog.create({
      data: {
        executionId: execution.id,
        level: LogLevel.INFO,
        message: `Pipeline triggered by ${opts.triggeredBy}`,
        metadata: {},
      },
    });

    return { executionId: execution.id, skipped: false };
  }
}
