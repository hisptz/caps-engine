import type { Channel } from "amqplib";
import { EXCHANGES, QUEUES } from "@/services/worker/constants/monitor.ts";
import { logger } from "@/shared/utils";

// ============================================================
// Exchange and queue names — single source of truth
// ============================================================

// How long a pipeline.executions message can sit unprocessed
// before being dead-lettered (5 minutes)
const PIPELINE_MESSAGE_TTL_MS = 5 * 60 * 1000;

// ============================================================
// setupTopology — call once on worker startup
// All assertions are idempotent: safe to call on every boot
// ============================================================

export async function setupTopology(channel: Channel): Promise<void> {
  // ----------------------------------------------------------
  // 1. Declare the dead letter exchange
  //    fanout: routes every dead message to all bound queues
  //    (we only bind one queue, caps.dead-letters)
  // ----------------------------------------------------------
  await channel.assertExchange(EXCHANGES.DLX, "fanout", {
    durable: true,
  });
  logger.info(`[topology] Exchange declared: ${EXCHANGES.DLX} (type=fanout, durable=true)`);

  // ----------------------------------------------------------
  // 2. Declare the dead letter holding queue
  //    No DLX of its own — dead letters stop here
  //    No TTL — messages sit until manually inspected/replayed
  // ----------------------------------------------------------
  await channel.assertQueue(QUEUES.DEAD_LETTERS, {
    durable: true,
  });
  logger.info(`[topology] Queue declared: ${QUEUES.DEAD_LETTERS} (durable=true, no-dlx)`);

  // Bind the holding queue to the DLX exchange
  await channel.bindQueue(QUEUES.DEAD_LETTERS, EXCHANGES.DLX, "");
  logger.info(`[topology] Queue bound: ${QUEUES.DEAD_LETTERS} → ${EXCHANGES.DLX}`);

  // ----------------------------------------------------------
  // 3. Declare work queues with DLX wiring
  // ----------------------------------------------------------

  // pipeline.executions — with TTL
  // A pipeline job sitting here for 5+ minutes is stuck
  await channel.assertQueue(QUEUES.PIPELINE_EXECUTIONS, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGES.DLX,
      "x-message-ttl": PIPELINE_MESSAGE_TTL_MS,
    },
  });
  logger.info(
    `[topology] Queue declared: ${QUEUES.PIPELINE_EXECUTIONS} (durable=true, dlx=${EXCHANGES.DLX}, ttl=${PIPELINE_MESSAGE_TTL_MS}ms)`
  );

  // pipeline.step-results — with DLX, no TTL
  // Step results should be processed quickly, but we don't
  // set a TTL here because brief coordinator backpressure is normal
  await channel.assertQueue(QUEUES.STEP_RESULTS, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGES.DLX,
    },
  });
  logger.info(
    `[topology] Queue declared: ${QUEUES.STEP_RESULTS} (durable=true, dlx=${EXCHANGES.DLX})`
  );

  // step.* queues — with DLX, no TTL
  // Long-running steps (predictions, heavy syncs) need no TTL
  // The coordinator's AWAITING_STEP status surfaces stuck pipelines
  for (const step of QUEUES.STEP.values()) {
    await channel.assertQueue(step.queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": EXCHANGES.DLX,
      },
    });
    logger.info(
      `[topology] Queue declared: ${step.queueName} (durable=true, dlx=${EXCHANGES.DLX})`
    );
  }

  logger.info("[topology] All exchanges and queues declared");
}
