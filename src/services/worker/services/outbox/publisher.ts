import { OutboxDeliveryStatus, PrismaClient, type OutboxMessage } from "@db/client";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import { randomUUID } from "node:crypto";
import { logger } from "@/shared/utils";

const DEFAULT_POLL_MS = 500;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 25;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export type OutboxPublisherOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
};

/**
 * Polls PENDING/expired-LEASED outbox rows and publishes them with RabbitMQ confirms.
 * A crash may redeliver the same payload; consumers must be idempotent on attempt IDs.
 */
export class OutboxPublisher {
  private readonly ownerId = randomUUID();
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private confirmChannel: ConfirmChannel | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly connection: ChannelModel,
    options: OutboxPublisherOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async start(): Promise<void> {
    this.confirmChannel = await this.connection.createConfirmChannel();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Kick once immediately
    void this.tick();
    logger.info(`[outbox] Publisher started owner=${this.ownerId}`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.confirmChannel) {
      await this.confirmChannel.close();
      this.confirmChannel = null;
    }
    logger.info(`[outbox] Publisher stopped owner=${this.ownerId}`);
  }

  /** Exposed for tests — process one batch. */
  async tick(): Promise<void> {
    if (this.running || !this.confirmChannel) return;
    this.running = true;
    try {
      const messages = await this.claimBatch();
      for (const message of messages) {
        await this.publishOne(message);
      }
    } catch (err) {
      logger.error("[outbox] Tick failed:", err);
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<OutboxMessage[]> {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.leaseMs);

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.outboxMessage.findMany({
        where: {
          OR: [
            { status: OutboxDeliveryStatus.PENDING, availableAt: { lte: now } },
            {
              status: OutboxDeliveryStatus.LEASED,
              leasedAt: { lte: leaseExpiredBefore },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: this.batchSize,
      });

      const claimed: OutboxMessage[] = [];
      for (const candidate of candidates) {
        const updated = await tx.outboxMessage.updateMany({
          where: {
            id: candidate.id,
            OR: [
              { status: OutboxDeliveryStatus.PENDING },
              {
                status: OutboxDeliveryStatus.LEASED,
                leasedAt: { lte: leaseExpiredBefore },
              },
            ],
          },
          data: {
            status: OutboxDeliveryStatus.LEASED,
            leaseOwner: this.ownerId,
            leasedAt: now,
            publishAttempts: { increment: 1 },
          },
        });
        if (updated.count === 1) {
          const row = await tx.outboxMessage.findUniqueOrThrow({
            where: { id: candidate.id },
          });
          claimed.push(row);
        }
      }
      return claimed;
    });
  }

  private async publishOne(message: OutboxMessage): Promise<void> {
    const channel = this.confirmChannel;
    if (!channel) return;

    if (message.publishAttempts > this.maxAttempts) {
      await this.prisma.outboxMessage.update({
        where: { id: message.id },
        data: {
          status: OutboxDeliveryStatus.FAILED,
          lastError: `Exceeded max publish attempts (${this.maxAttempts})`,
          leaseOwner: null,
          leasedAt: null,
        },
      });
      logger.error(
        `[outbox] Message permanently failed id=${message.id} destination=${message.destination}`
      );
      return;
    }

    try {
      const body = Buffer.from(JSON.stringify(message.payload));
      await new Promise<void>((resolve, reject) => {
        channel.sendToQueue(
          message.destination,
          body,
          { persistent: true, messageId: message.id },
          (err) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else resolve();
          }
        );
      });

      await this.prisma.outboxMessage.updateMany({
        where: {
          id: message.id,
          status: OutboxDeliveryStatus.LEASED,
          leaseOwner: this.ownerId,
        },
        data: {
          status: OutboxDeliveryStatus.PUBLISHED,
          publishedAt: new Date(),
          leaseOwner: null,
          leasedAt: null,
          lastError: null,
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const attempt = message.publishAttempts;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
      await this.prisma.outboxMessage.updateMany({
        where: {
          id: message.id,
          status: OutboxDeliveryStatus.LEASED,
          leaseOwner: this.ownerId,
        },
        data: {
          status: OutboxDeliveryStatus.PENDING,
          leaseOwner: null,
          leasedAt: null,
          lastError: errorMessage,
          availableAt: new Date(Date.now() + delay),
        },
      });
      logger.warn(
        `[outbox] Publish failed id=${message.id} attempt=${attempt} retryInMs=${delay}: ${errorMessage}`
      );
    }
  }
}
