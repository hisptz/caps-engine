import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PipelineExecutionStatus,
  PrismaClient,
  StepAttemptKind,
  StepExecutionStatus,
  type Prisma,
} from "@db/client";
import { StepRetryService } from "@/services/api/utils/monitoring/retry.ts";
import { snapshotFromPipelineStep } from "@/shared/pipeline/stepSnapshot.ts";
import {
  clearExecutionData,
  createTestPrisma,
  seedExecution,
  seedPipeline,
  seedStep,
} from "../utils/helpers.ts";

let prisma: PrismaClient;
let service: StepRetryService;

beforeAll(() => {
  prisma = createTestPrisma();
  service = new StepRetryService(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
});

describe("StepRetryService", () => {
  it("creates a MANUAL attempt, preserves cursor/context, and enqueues outbox", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, { maxRetries: 0 });
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.FAILED,
      currentStepIndex: 0,
      context: { step_prev: { ok: true } },
    });
    const snapshot = snapshotFromPipelineStep(step);
    const failed = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: StepExecutionStatus.FAILED,
        attemptKind: StepAttemptKind.AUTOMATIC,
        stepSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        errorMessage: "boom",
        finishedAt: new Date(),
      },
    });

    const result = await service.retryStepExecution(failed.id, "idem-key-001");

    expect(result.status).toBe("ACCEPTED");
    expect(result.reused).toBe(false);

    const revived = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(revived.status).toBe(PipelineExecutionStatus.RUNNING);
    expect(revived.finishedAt).toBeNull();
    expect(revived.currentStepIndex).toBe(0);
    expect(revived.context).toMatchObject({ step_prev: { ok: true } });

    const replacement = await prisma.stepExecution.findUniqueOrThrow({
      where: { id: result.replacementStepExecutionId },
    });
    expect(replacement).toMatchObject({
      attemptNumber: 2,
      attemptKind: StepAttemptKind.MANUAL,
      status: StepExecutionStatus.PENDING,
    });
    expect(replacement.stepSnapshot).toMatchObject(snapshot);

    const outbox = await prisma.outboxMessage.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.destination).toBe("pipeline.executions");
  });

  it("returns the same command for a repeated idempotency key", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.FAILED,
    });
    const failed = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: StepExecutionStatus.FAILED,
        stepSnapshot: snapshotFromPipelineStep(step) as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });

    const first = await service.retryStepExecution(failed.id, "idem-same");
    const second = await service.retryStepExecution(failed.id, "idem-same");

    expect(second.reused).toBe(true);
    expect(second.retryCommandId).toBe(first.retryCommandId);
    expect(second.replacementStepExecutionId).toBe(first.replacementStepExecutionId);

    const attempts = await prisma.stepExecution.count({
      where: { executionId: execution.id },
    });
    expect(attempts).toBe(2);
  });

  it("rejects retry when snapshot is missing", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.FAILED,
    });
    const failed = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: StepExecutionStatus.FAILED,
        finishedAt: new Date(),
      },
    });

    await expect(service.retryStepExecution(failed.id, "idem-legacy")).rejects.toMatchObject({
      status: 409,
      code: "MISSING_STEP_SNAPSHOT",
    });
  });
});
