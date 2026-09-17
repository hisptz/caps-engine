import amqplib from "amqplib";
import { setupTelemetry } from "@/shared/telemetry/index.ts";

// Import all handlers so the registry is populated before any message is consumed
import "./services/handlers/index.ts";
import {
  PIPELINE_QUEUE,
  PipelineCoordinator,
  type PipelineJobMessage,
  STEP_RESULTS_QUEUE,
  type StepJobMessage,
  type StepResultMessage,
} from "@/services/worker/services/runners/pipeline.ts";
import { createDbClient } from "@/shared/clients/db.ts";
import { StepRunner } from "@/services/worker/services/runners/step.ts";
import { StepWorker } from "@/services/worker/services/workers/step.ts";
import { env, logger, printBanner } from "@/shared/utils";
import { setupTopology } from "@/services/worker/services/monitor/topology.ts";
import { DlxMonitor } from "@/services/worker/services/monitor/monitor.ts";
import { STEP_QUEUES } from "@/services/worker/constants/handlers.ts";
import { OutboxPublisher } from "@/services/worker/services/outbox/publisher.ts";

// ============================================================
// Queue names for step-specific workers (from the handler registry)
// ============================================================

async function startWorker() {
  const shutdownTelemetry = setupTelemetry();
  await printBanner("CAPS Worker");
  logger.info("Starting CAPS worker...");
  const prisma = createDbClient();
  logger.info("[worker] DB client created");
  const connection = await amqplib.connect(env.RABBITMQ_URL);
  logger.info("[worker] RabbitMQ connection established");
  const channel = await connection.createChannel();

  //Declares all queues and exchanges
  await setupTopology(channel);

  // One message at a time per process
  await channel.prefetch(1);

  const stepRunner = new StepRunner({ prisma });
  const coordinator = new PipelineCoordinator({ prisma, channel, stepRunner });
  const stepWorker = new StepWorker({ prisma, channel });
  const dlxMonitor = new DlxMonitor(prisma, channel);
  const outboxPublisher = new OutboxPublisher(prisma, connection);

  // --------------------------------------------------------
  // Consumer 1: pipeline coordinator
  // Woken by pipeline triggers and by step-result completions
  // --------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  await channel.consume(PIPELINE_QUEUE, async (msg) => {
    if (!msg) return;
    let executionId: string | undefined;
    try {
      ({ executionId } = JSON.parse(msg.content.toString()) as PipelineJobMessage);
      logger.info(`[worker] [coordinator] Message received executionId=${executionId}`);
      await coordinator.handle(executionId);
      logger.info(`[worker] [coordinator] Ack executionId=${executionId}`);
      channel.ack(msg);
    } catch (err) {
      logger.error("[coordinator] Unhandled error:", err);
      logger.warn(
        `[worker] [coordinator] Nack (no requeue) executionId=${executionId ?? "unknown"}`
      );
      channel.nack(msg, false, false);
    }
  });

  // --------------------------------------------------------
  // Consumer 2: step result handler
  // Woken when any step worker finishes a queued step
  // --------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  await channel.consume(STEP_RESULTS_QUEUE, async (msg) => {
    if (!msg) return;
    let parsedResult: StepResultMessage | undefined;
    try {
      parsedResult = JSON.parse(msg.content.toString()) as StepResultMessage;
      logger.info(
        `[worker] [step-results] Message received executionId=${parsedResult.executionId} stepExecutionId=${parsedResult.stepExecutionId}`
      );
      await coordinator.handleStepResult(parsedResult);
      logger.info(`[worker] [step-results] Ack executionId=${parsedResult.executionId}`);
      channel.ack(msg);
    } catch (err) {
      logger.error("[step-results] Unhandled error:", err);
      logger.warn(
        `[worker] [step-results] Nack (no requeue) executionId=${parsedResult?.executionId ?? "unknown"}`
      );
      channel.nack(msg, false, false);
    }
  });

  // --------------------------------------------------------
  // Consumer 3: step-specific queue workers
  // Each step queue can be consumed by a dedicated worker pool
  // in a separate process — this wires them up in a single
  // process for simplicity, but they can be split out
  // --------------------------------------------------------
  for (const queueName of STEP_QUEUES) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    await channel.consume(queueName, async (msg) => {
      if (!msg) return;
      let job: StepJobMessage | undefined;
      try {
        job = JSON.parse(msg.content.toString()) as StepJobMessage;
        logger.info(
          `[worker] [${queueName}] Message received executionId=${job.executionId} stepExecutionId=${job.stepExecutionId}`
        );
        await stepWorker.handle(job);
        logger.info(`[worker] [${queueName}] Ack executionId=${job.executionId}`);
        channel.ack(msg);
      } catch (err) {
        logger.error(`[${queueName}] Unhandled error:`, err);
        logger.warn(
          `[worker] [${queueName}] Nack (no requeue) executionId=${job?.executionId ?? "unknown"}`
        );
        channel.nack(msg, false, false);
      }
    });
    logger.info(`Listening on: ${queueName}`);
  }

  await dlxMonitor.start();
  await outboxPublisher.start();

  logger.info(`Listening on: ${PIPELINE_QUEUE}`);
  logger.info(`Listening on: ${STEP_RESULTS_QUEUE}`);

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on("SIGTERM", async () => {
    logger.info("[worker] SIGTERM received — beginning graceful shutdown");
    await outboxPublisher.stop();
    await channel.close();
    await connection.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    logger.info("[worker] Shutdown complete");
    process.exit(0);
  });
}

startWorker().catch((err) => {
  logger.error("Fatal startup error:", err);
  process.exit(1);
});
