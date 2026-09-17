import { LogLevel, PipelineExecutionStatus, PrismaClient } from "@db/client";
import type { Channel, ConsumeMessage } from "amqplib";
import { logger } from "@/shared/utils";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { QUEUES } from "@/services/worker/constants/monitor.ts";

// ============================================================
// Dead message metadata
// RabbitMQ adds x-death headers to every dead-lettered message
// ============================================================

interface XDeath {
  queue: string;
  reason: "rejected" | "expired" | "maxlen";
  time: { value: number };
  count: number;
  "routing-keys": string[];
  exchange: string;
}

interface DeadMessageHeaders {
  "x-death"?: XDeath[];
  "x-first-death-queue"?: string;
  "x-first-death-reason"?: string;
}

// ============================================================
// Dead letter monitor
// ============================================================

export class DlxMonitor {
  constructor(
    private prisma: PrismaClient,
    private channel: Channel
  ) {}

  async start(): Promise<void> {
    await this.channel.consume(
      QUEUES.DEAD_LETTERS,
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      async (msg) => {
        if (!msg) return;

        try {
          await this.handleDeadMessage(msg);
          // Always ack — we've logged and handled it.
          // Nacking here would cause an infinite loop back into the DLX.
          this.channel.ack(msg);
        } catch (err) {
          logger.error("[dlx-monitor] Error handling dead message:", err);
          // Still ack to avoid the infinite loop — the error is logged above
          this.channel.ack(msg);
        }
      },
      { noAck: false }
    );

    logger.info(`[dlx-monitor] Watching: ${QUEUES.DEAD_LETTERS}`);
  }

  private async handleDeadMessage(msg: ConsumeMessage): Promise<void> {
    const headers = msg.properties.headers as DeadMessageHeaders;
    const xDeath = headers["x-death"]?.[0];
    const sourceQueue = xDeath?.queue ?? headers["x-first-death-queue"] ?? "unknown";
    const reason = xDeath?.reason ?? headers["x-first-death-reason"] ?? "unknown";

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(msg.content.toString()) as Record<string, unknown>;
    } catch {
      logger.error("[dlx-monitor] Could not parse dead message body:", msg.content.toString());
      return;
    }

    logger.warn("[dlx-monitor] Dead message received", {
      sourceQueue,
      reason,
      body,
    });

    // Attempt to extract executionId from the dead message body.
    // Both PipelineJobMessage and StepJobMessage carry executionId.
    const executionId = (body.executionId as string) ?? null;

    if (executionId) {
      await this.markExecutionFailed(executionId, sourceQueue, reason);
    }

    // Store the dead message for inspection and potential replay
    await this.logDeadMessage({
      executionId,
      sourceQueue,
      reason,
      body,
      xDeath,
    });
  }

  // Mark the pipeline execution as FAILED so the monitoring
  // UI reflects reality — the pipeline is not stuck in AWAITING_STEP
  private async markExecutionFailed(
    executionId: string,
    sourceQueue: string,
    reason: string
  ): Promise<void> {
    try {
      const execution = await this.prisma.pipelineExecution.findUnique({
        where: { id: executionId },
      });

      if (!execution) return;

      // Only update if still in an active state — don't overwrite
      // a COMPLETED execution if somehow a stale message arrives
      const activeStatuses: PipelineExecutionStatus[] = [
        PipelineExecutionStatus.PENDING,
        PipelineExecutionStatus.RUNNING,
        PipelineExecutionStatus.AWAITING_STEP,
      ];

      if (!activeStatuses.includes(execution.status)) return;

      await this.prisma.pipelineExecution.update({
        where: { id: executionId },
        data: {
          status: PipelineExecutionStatus.FAILED,
          finishedAt: new Date(),
        },
      });

      await this.prisma.executionLog.create({
        data: {
          executionId,
          level: LogLevel.ERROR,
          message: `Pipeline failed: message dead-lettered from ${sourceQueue}`,
          metadata: { sourceQueue, reason, deadLetteredAt: new Date().toISOString() },
        },
      });

      logger.error(
        `[dlx-monitor] Marked execution FAILED: ${executionId} (from ${sourceQueue}, reason: ${reason})`
      );
    } catch (err) {
      logger.error("[dlx-monitor] Failed to update execution status:", err);
    }
  }

  // Write a structured record of the dead message for the replay API
  private async logDeadMessage(details: {
    executionId: string | null;
    sourceQueue: string;
    reason: string;
    body: Record<string, unknown>;
    xDeath?: XDeath;
  }): Promise<void> {
    // For now we log to execution_logs if we have an executionId.
    // You could also write to a dedicated dead_letters table for
    // full replay support with message body storage.
    if (!details.executionId) {
      logger.warn("[dlx-monitor] Dead message with no executionId:", details);
      return;
    }

    const execution = await this.prisma.pipelineExecution.findUnique({
      where: { id: details.executionId },
      select: { id: true },
    });

    if (!execution) {
      logger.warn(
        `[dlx-monitor] Dead message for deleted execution ${details.executionId}:`,
        details
      );
      return;
    }

    await this.prisma.executionLog.create({
      data: {
        executionId: details.executionId,
        level: LogLevel.ERROR,
        message: "Dead letter received",
        metadata: {
          sourceQueue: details.sourceQueue,
          reason: details.reason,
          messageBody: details.body,
          deathCount: details.xDeath?.count ?? 1,
          deadLetteredAt: new Date().toISOString(),
        } as InputJsonValue,
      },
    });
  }
}

// ============================================================
// Replay — re-publishes a dead message back to its source queue
// Call this from an admin API endpoint when you want to retry
// a dead-lettered message
// ============================================================

export function replayDeadMessage(
  channel: Channel,
  targetQueue: string,
  messageBody: Record<string, unknown>
) {
  channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(messageBody)), {
    persistent: true,
    // Strip x-death headers so RabbitMQ treats this as a fresh message
    headers: {},
  });
  logger.info(`[dlx-monitor] Replayed message to ${targetQueue}:`, messageBody);
}
