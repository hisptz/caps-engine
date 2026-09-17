import type { PipelineExecution, PipelineStep, StepExecution, TaskExecution } from "@db/client.ts"; // ============================================================
import {
  PipelineExecutionStatus,
  PrismaClient,
  StepAttemptKind,
  StepExecutionStatus,
  TaskExecutionStatus,
} from "@db/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { vi } from "vitest";
import * as amqplib from "amqplib";
import type { Channel, ChannelModel } from "amqplib";
import type { StepContext, TaskHandle, TaskReporter } from "@/services/worker/types/service.ts";

// ============================================================
// Test Prisma client
// Uses a small connection pool (max=3) to avoid exhausting the
// PostgreSQL connection limit when multiple test files run in parallel.
// ============================================================

export function createTestPrisma(): PrismaClient {
  const connectionString = process.env["DATABASE_URL_TEST"] ?? process.env["DATABASE_URL"] ?? "";
  const pool = new Pool({ connectionString, max: 3 });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter, log: ["error"] });
}

// ============================================================
// Real RabbitMQ channel for integration tests
// Connects to the container started by the integration globalSetup.
// Returns a { connection, channel } pair where `sendToQueue` (and
// other key methods) are wrapped with vi.spyOn so tests can assert on
// calls while still exercising real RabbitMQ semantics.
// ============================================================

export async function createTestRabbitmqConnection(): Promise<ChannelModel> {
  const url = process.env["RABBITMQ_URL_TEST"] ?? "amqp://guest:guest@localhost:5672";
  return amqplib.connect(url);
}

export async function createTestChannel(
  connection: ChannelModel,
  queues: string[] = []
): Promise<Channel> {
  const channel = await connection.createChannel();

  // Declare any queues the caller needs up-front (non-durable for tests)
  for (const q of queues) {
    await channel.assertQueue(q, { durable: false });
  }

  // Spy on the methods coordinator tests assert on.
  // vi.spyOn calls through by default, so real messages are still sent.
  vi.spyOn(channel, "sendToQueue");
  vi.spyOn(channel, "publish");

  return channel;
}

// ============================================================
// Mock factories — pure in-memory objects with vi.fn() stubs
// ============================================================

export function buildMockTaskExecution(overrides?: Partial<TaskExecution>): TaskExecution {
  return {
    id: "task-execution-id",
    stepExecutionId: "step-execution-id",
    name: "test-task",
    taskOrder: 0,
    status: TaskExecutionStatus.RUNNING,
    input: null,
    output: null,
    errorMessage: null,
    errorStack: null,
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function buildMockTaskHandle(overrides?: Partial<TaskHandle>): TaskHandle {
  return {
    taskExecution: buildMockTaskExecution(),
    log: vi.fn().mockResolvedValue(undefined),
    succeed: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function buildMockTaskReporter(overrides?: Partial<TaskReporter>): TaskReporter {
  return {
    startTask: vi.fn().mockResolvedValue(buildMockTaskHandle()),
    ...overrides,
  };
}

export function buildMockStep(overrides?: Partial<PipelineStep>): PipelineStep {
  return {
    id: "step-id",
    pipelineId: "pipeline-id",
    name: "test-step",
    description: null,
    handlerKey: "test-handler",
    stepOrder: 0,
    maxRetries: 0,
    retryDelayMs: 0,
    inputSchema: null,
    handlerConfig: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function buildMockStepExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    id: "step-execution-id",
    executionId: "execution-id",
    stepId: "step-id",
    status: StepExecutionStatus.RUNNING,
    attemptNumber: 1,
    attemptKind: StepAttemptKind.AUTOMATIC,
    stepSnapshot: null,
    input: null,
    output: null,
    errorMessage: null,
    errorStack: null,
    resultProcessedAt: null,
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function buildMockExecution(overrides?: Partial<PipelineExecution>): PipelineExecution {
  return {
    id: "execution-id",
    pipelineId: "pipeline-id",
    scheduleId: null,
    status: PipelineExecutionStatus.PENDING,
    context: {},
    currentStepIndex: 0,
    triggeredBy: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function buildMockContext(overrides?: Partial<StepContext>): StepContext {
  return {
    step: buildMockStep(),
    stepExecution: buildMockStepExecution(),
    pipelineContext: {},
    input: undefined,
    handlerConfig: {},
    log: vi.fn().mockResolvedValue(undefined),
    tasks: buildMockTaskReporter(),
    ...overrides,
  };
}

export function buildMockChannel(): Channel {
  return {
    sendToQueue: vi.fn().mockReturnValue(true),
    consume: vi.fn().mockResolvedValue({ consumerTag: "test-tag" }),
    ack: vi.fn(),
    nack: vi.fn(),
    reject: vi.fn(),
    prefetch: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi
      .fn()
      .mockResolvedValue({ queue: "test-queue", messageCount: 0, consumerCount: 0 }),
    assertExchange: vi.fn().mockResolvedValue({ exchange: "test-exchange" }),
    bindQueue: vi.fn().mockResolvedValue({}),
    unbindQueue: vi.fn().mockResolvedValue({}),
    deleteQueue: vi.fn().mockResolvedValue({ messageCount: 0 }),
    purgeQueue: vi.fn().mockResolvedValue({ messageCount: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(false),
    publish: vi.fn().mockReturnValue(true),
    checkQueue: vi
      .fn()
      .mockResolvedValue({ queue: "test-queue", messageCount: 0, consumerCount: 0 }),
    checkExchange: vi.fn().mockResolvedValue({}),
    deleteExchange: vi.fn().mockResolvedValue({}),
    bindExchange: vi.fn().mockResolvedValue({}),
    unbindExchange: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
  } as unknown as Channel;
}

// ============================================================
// Database seed helpers
// ============================================================

export async function seedPipeline(
  prisma: PrismaClient,
  overrides?: { name?: string; config?: object; isActive?: boolean }
) {
  return prisma.pipeline.create({
    data: {
      name: overrides?.name ?? `test-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      config: overrides?.config ?? {},
      isActive: overrides?.isActive ?? true,
    },
  });
}

export async function seedStep(
  prisma: PrismaClient,
  pipelineId: string,
  overrides?: {
    name?: string;
    handlerKey?: string;
    stepOrder?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    handlerConfig?: object;
  }
) {
  return prisma.pipelineStep.create({
    data: {
      pipelineId,
      name: overrides?.name ?? "test-step",
      handlerKey: overrides?.handlerKey ?? "test-handler",
      stepOrder: overrides?.stepOrder ?? 0,
      maxRetries: overrides?.maxRetries ?? 0,
      retryDelayMs: overrides?.retryDelayMs ?? 0,
      handlerConfig: overrides?.handlerConfig ?? {},
    },
  });
}

export async function seedExecution(
  prisma: PrismaClient,
  pipelineId: string,
  overrides?: {
    status?: PipelineExecutionStatus;
    context?: object;
    currentStepIndex?: number;
    triggeredBy?: string;
  }
) {
  return prisma.pipelineExecution.create({
    data: {
      pipelineId,
      status: overrides?.status ?? PipelineExecutionStatus.PENDING,
      context: overrides?.context ?? {},
      currentStepIndex: overrides?.currentStepIndex ?? 0,
      triggeredBy: overrides?.triggeredBy ?? null,
    },
  });
}

// ============================================================
// Cleanup — deletes in FK-safe order
// ============================================================

export async function clearExecutionData(prisma: PrismaClient): Promise<void> {
  await prisma.executionLog.deleteMany();
  await prisma.taskExecution.deleteMany();
  await prisma.stepRetryCommand.deleteMany();
  await prisma.stepExecution.deleteMany();
  await prisma.outboxMessage.deleteMany();
  await prisma.pipelineExecution.deleteMany();
  await prisma.pipelineSchedule.deleteMany();
  await prisma.pipelineStep.deleteMany();
  await prisma.pipeline.deleteMany();
}

/** Flush pending outbox rows synchronously for tests (no RabbitMQ confirms). */
export async function flushOutboxForTests(
  prisma: PrismaClient,
  channel: { sendToQueue: (q: string, content: Buffer, opts?: object) => unknown }
): Promise<number> {
  const pending = await prisma.outboxMessage.findMany({
    where: { status: { in: ["PENDING", "LEASED"] } },
    orderBy: { createdAt: "asc" },
  });
  for (const message of pending) {
    channel.sendToQueue(message.destination, Buffer.from(JSON.stringify(message.payload)), {
      persistent: true,
      messageId: message.id,
    });
    await prisma.outboxMessage.update({
      where: { id: message.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), leaseOwner: null, leasedAt: null },
    });
  }
  return pending.length;
}
