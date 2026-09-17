import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PipelineExecutionStatus, PrismaClient, StepExecutionStatus } from "@db/client.ts";
import {
  PIPELINE_QUEUE,
  PipelineCoordinator,
} from "@/services/worker/services/runners/pipeline.ts";
import { StepRunner } from "@/services/worker/services/runners/step.ts";
import type { ChannelModel, Channel } from "amqplib";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { getHandlerQueueName } from "@/shared/handlers/catalog.ts";
import {
  clearExecutionData,
  createTestPrisma,
  createTestRabbitmqConnection,
  createTestChannel,
  flushOutboxForTests,
  seedExecution,
  seedPipeline,
  seedStep,
} from "../utils/helpers.ts";
import { stubBun } from "../utils/bun.ts";

// ============================================================
// Mock telemetry
// ============================================================

vi.mock("@/shared/telemetry/index.ts", () => ({
  tracer: {
    startSpan: () => ({
      setStatus: vi.fn(),
      recordException: vi.fn(),
      setAttribute: vi.fn(),
      end: vi.fn(),
    }),
  },
  stepExecutionCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
  pipelineExecutionCounter: { add: vi.fn() },
}));

// ============================================================
// Mock Bun.sleep to avoid real delays in retry tests
// ============================================================

const mockBunSleep = vi.fn().mockResolvedValue(undefined);

// ============================================================
// Shared state — real RabbitMQ connection + channel
// ============================================================

const STEP_QUEUE = getHandlerQueueName(Handlers.CLIMATE_OPENEO_CREATE)!;
const STEP_RESULTS_QUEUE = "pipeline.step-results";

let prisma: PrismaClient;
let rmqConnection: ChannelModel;
let channel: Channel;

beforeAll(async () => {
  prisma = createTestPrisma();
  rmqConnection = await createTestRabbitmqConnection();
  channel = await createTestChannel(rmqConnection, [
    PIPELINE_QUEUE,
    STEP_QUEUE,
    STEP_RESULTS_QUEUE,
  ]);
});

afterAll(async () => {
  await channel.close();
  await rmqConnection.close();
  await prisma.$disconnect();
});

afterEach(async () => {
  vi.clearAllMocks();
  await clearExecutionData(prisma);
  // Drain any messages published during the test so queues stay clean
  for (const q of [PIPELINE_QUEUE, STEP_QUEUE, STEP_RESULTS_QUEUE]) {
    try {
      await channel.purgeQueue(q);
    } catch {
      // ignore — queue may not exist in all configurations
    }
  }
});

// ============================================================
// Helpers
// ============================================================

function buildCoordinator(stepRunnerOverride?: Partial<StepRunner>) {
  // Re-spy after each restoreMocks cycle
  vi.spyOn(channel, "sendToQueue");
  stubBun({ sleep: mockBunSleep });

  const stepRunner = {
    run: vi.fn().mockResolvedValue({ succeeded: true, output: { result: "ok" } }),
    ...stepRunnerOverride,
  } as unknown as StepRunner;

  return {
    coordinator: new PipelineCoordinator({ prisma, channel, stepRunner }),
    mockRun: (stepRunner as unknown as { run: ReturnType<typeof vi.fn> }).run,
  };
}

async function getExecution(id: string) {
  return prisma.pipelineExecution.findUniqueOrThrow({ where: { id } });
}

// ============================================================
// Inline step tests
// ============================================================

describe("PipelineCoordinator — inline steps (unknown handler)", () => {
  it("transitions PENDING → RUNNING → COMPLETED through a single step", async () => {
    const { coordinator, mockRun } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, { maxRetries: 0 });
    const execution = await seedExecution(prisma, pipeline.id);

    // First handle: starts the pipeline, runs step 0, advances cursor, re-publishes
    await coordinator.handle(execution.id);

    let exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.RUNNING);
    expect(exec.currentStepIndex).toBe(1);
    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: step.id }),
      expect.objectContaining({ id: execution.id }),
      1,
      undefined
    );

    // Second handle: stepIndex >= steps.length → COMPLETED
    await coordinator.handle(execution.id);

    exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.COMPLETED);
    expect(exec.finishedAt).toBeInstanceOf(Date);
  });

  it("re-publishes to PIPELINE_QUEUE after each inline step succeeds", async () => {
    const { coordinator } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id);
    await flushOutboxForTests(prisma, channel);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      PIPELINE_QUEUE,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
    const sentMsg = JSON.parse(
      vi
        .mocked(channel.sendToQueue)
        .mock.calls.find(([q]) => q === PIPELINE_QUEUE)![1]
        .toString()
    );
    expect(sentMsg.executionId).toBe(execution.id);
  });

  it("advances cursor and stores output in context for multi-step pipelines", async () => {
    let callCount = 0;
    const { coordinator, mockRun } = buildCoordinator();

    mockRun.mockImplementation(async (_step: unknown, _exec: unknown, attempt: number) => {
      callCount++;
      return { succeeded: true, output: { stepIndex: callCount, attempt } };
    });

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { name: "step-0", stepOrder: 0 });
    await seedStep(prisma, pipeline.id, { name: "step-1", stepOrder: 1 });
    await seedStep(prisma, pipeline.id, { name: "step-2", stepOrder: 2 });
    const execution = await seedExecution(prisma, pipeline.id);

    // 3 steps + 1 final completion call
    await coordinator.handle(execution.id); // step 0
    await coordinator.handle(execution.id); // step 1
    await coordinator.handle(execution.id); // step 2
    await coordinator.handle(execution.id); // complete

    const exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.COMPLETED);
    expect(exec.currentStepIndex).toBe(3);
    expect(mockRun).toHaveBeenCalledTimes(3);

    const ctx = exec.context as Record<string, unknown>;
    expect(ctx["step_0_output"]).toBeDefined();
    expect(ctx["step_1_output"]).toBeDefined();
    expect(ctx["step_2_output"]).toBeDefined();
  });

  it("passes previous step output as input to next step", async () => {
    const { coordinator, mockRun } = buildCoordinator();

    mockRun.mockResolvedValueOnce({ succeeded: true, output: { climateData: [1, 2, 3] } });
    mockRun.mockResolvedValueOnce({ succeeded: true, output: { predictions: [4, 5, 6] } });

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { name: "step-0", stepOrder: 0 });
    await seedStep(prisma, pipeline.id, { name: "step-1", stepOrder: 1 });
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id); // step 0 → output { climateData }
    await coordinator.handle(execution.id); // step 1 receives step 0 output as input

    const step1Call = mockRun.mock.calls[1]!;
    expect(step1Call[3]).toEqual({ climateData: [1, 2, 3] }); // input = step_0_output
  });

  it("marks execution FAILED after all retries are exhausted (maxRetries=2)", async () => {
    const { coordinator, mockRun } = buildCoordinator();
    mockRun.mockResolvedValue({ succeeded: false, error: new Error("handler error") });

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { maxRetries: 2, retryDelayMs: 1 });
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id);

    const exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.FAILED);
    expect(exec.finishedAt).toBeInstanceOf(Date);

    // maxRetries=2 means 3 total attempts
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it("marks execution FAILED immediately when maxRetries=0 and step fails", async () => {
    const { coordinator, mockRun } = buildCoordinator();
    mockRun.mockResolvedValue({ succeeded: false, error: new Error("immediate fail") });

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { maxRetries: 0 });
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id);

    expect(mockRun).toHaveBeenCalledOnce();
    const exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.FAILED);
  });

  it("calls Bun.sleep for each retry but not on the first attempt", async () => {
    const { coordinator, mockRun } = buildCoordinator();
    mockRun.mockResolvedValue({ succeeded: false, error: new Error("retry me") });

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { maxRetries: 3, retryDelayMs: 10 });
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id);

    // 4 total attempts (1 + 3 retries); Bun.sleep called 3 times (attempts 2, 3, 4)
    expect(mockBunSleep).toHaveBeenCalledTimes(3);
  });

  it("resumes from currentStepIndex and skips earlier steps", async () => {
    const { coordinator, mockRun } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    await seedStep(prisma, pipeline.id, { name: "step-0", stepOrder: 0 });
    await seedStep(prisma, pipeline.id, { name: "step-1", stepOrder: 1 });
    // Seed execution with cursor already at step 1 and RUNNING status
    const execution = await seedExecution(prisma, pipeline.id, {
      currentStepIndex: 1,
      status: PipelineExecutionStatus.RUNNING,
    });

    await coordinator.handle(execution.id);

    // Only step 1 should be run (step 0 is skipped)
    expect(mockRun).toHaveBeenCalledOnce();
    const callArgs = mockRun.mock.calls[0]!;
    expect(callArgs[0]).toMatchObject({ name: "step-1" });
  });
});

// ============================================================
// Queued step tests
// ============================================================

describe("PipelineCoordinator — queued steps (known handler)", () => {
  it("dispatches to step queue and sets execution to AWAITING_STEP", async () => {
    const { coordinator } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, {
      handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
    });
    const execution = await seedExecution(prisma, pipeline.id);

    await coordinator.handle(execution.id);
    await flushOutboxForTests(prisma, channel);

    const exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.AWAITING_STEP);

    // Verify StepExecution pre-created as PENDING (worker claims → RUNNING)
    const stepExec = await prisma.stepExecution.findFirst({
      where: { executionId: execution.id, stepId: step.id },
    });
    expect(stepExec).toMatchObject({
      status: StepExecutionStatus.PENDING,
      attemptNumber: 1,
    });
    expect(stepExec?.stepSnapshot).toBeTruthy();

    // Verify message published to correct queue via outbox flush
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      STEP_QUEUE,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
    const queueMsg = JSON.parse(
      vi
        .mocked(channel.sendToQueue)
        .mock.calls.find(([q]) => q === STEP_QUEUE)![1]
        .toString()
    );
    expect(queueMsg.executionId).toBe(execution.id);
    expect(queueMsg.stepExecutionId).toBe(stepExec!.id);
  });

  it("handleStepResult success: advances cursor and re-publishes to pipeline queue", async () => {
    const { coordinator } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, {
      handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
    });
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    // Pre-create a stepExecution as the worker would have created it
    const stepExec = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: StepExecutionStatus.SUCCEEDED,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    await coordinator.handleStepResult({
      executionId: execution.id,
      stepExecutionId: stepExec.id,
      succeeded: true,
      output: { climateData: [1, 2] },
    });
    await flushOutboxForTests(prisma, channel);

    const exec = await getExecution(execution.id);
    expect(exec.currentStepIndex).toBe(1);
    expect(exec.status).toBe(PipelineExecutionStatus.RUNNING);

    // Should republish to pipeline.executions so coordinator continues
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      PIPELINE_QUEUE,
      expect.any(Buffer),
      expect.anything()
    );
  });

  it("handleStepResult failure with retries remaining: re-dispatches to step queue", async () => {
    const { coordinator } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, {
      handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    // First attempt already exists
    const stepExec = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: StepExecutionStatus.FAILED,
        startedAt: new Date(),
        finishedAt: new Date(),
        errorMessage: "first failure",
      },
    });

    await coordinator.handleStepResult({
      executionId: execution.id,
      stepExecutionId: stepExec.id,
      succeeded: false,
      errorMessage: "first failure",
    });
    await flushOutboxForTests(prisma, channel);

    // Should NOT mark as FAILED yet (1 attempt < maxRetries=2)
    const exec = await getExecution(execution.id);
    expect(exec.status).not.toBe(PipelineExecutionStatus.FAILED);

    // New StepExecution should have been created for attempt 2
    const attempts = await prisma.stepExecution.findMany({
      where: { executionId: execution.id, stepId: step.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      status: StepExecutionStatus.PENDING,
    });

    // Should re-dispatch to step queue
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      STEP_QUEUE,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
  });

  it("handleStepResult failure exhausted: marks execution FAILED, does not re-publish", async () => {
    const { coordinator } = buildCoordinator();

    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, {
      handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    // Two failed attempts already exist (attempt 1 + attempt 2 = maxRetries exhausted)
    await prisma.stepExecution.createMany({
      data: [
        {
          executionId: execution.id,
          stepId: step.id,
          attemptNumber: 1,
          status: StepExecutionStatus.FAILED,
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: step.id,
          attemptNumber: 2,
          status: StepExecutionStatus.FAILED,
          startedAt: new Date(),
        },
      ],
    });

    const lastStepExec = await prisma.stepExecution.findFirst({
      where: { executionId: execution.id, attemptNumber: 2 },
    });

    await coordinator.handleStepResult({
      executionId: execution.id,
      stepExecutionId: lastStepExec!.id,
      succeeded: false,
      errorMessage: "final failure",
    });

    const exec = await getExecution(execution.id);
    expect(exec.status).toBe(PipelineExecutionStatus.FAILED);
    expect(exec.finishedAt).toBeInstanceOf(Date);

    // Should NOT send to pipeline queue or step queue
    const sendCalls = vi.mocked(channel.sendToQueue).mock.calls;
    expect(sendCalls.every(([q]) => q !== PIPELINE_QUEUE && q !== STEP_RESULTS_QUEUE)).toBe(true);
  });
});
