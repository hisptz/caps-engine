import { describe, it, expect, vi, beforeEach } from "vitest";
import { PipelineExecutionStatus, StepExecutionStatus, type PrismaClient } from "@db/client";
import type { Channel } from "amqplib";
import { buildMockStep, buildMockStepExecution } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/handlers/catalog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/handlers/catalog.ts")>()),
  resolveStepQueueName: (handlerKey: string) => `step.${handlerKey}`,
}));
vi.mock("@/services/worker/utils/resolveEffectiveHandlerConfig.ts", () => ({
  resolveEffectiveHandlerConfig: () => ({}),
}));

import { StepWorker } from "@/services/worker/services/workers/step.ts";
import { STEP_RESULTS_QUEUE } from "@/services/worker/services/runners/pipeline.ts";
import {
  registerHandler,
  StepPermanentError,
  StepWaitingError,
  type StepContext,
} from "@/services/worker/types/service.ts";

const seenWaitStates: Array<Record<string, unknown> | undefined> = [];

registerHandler("test-wait", {
  async execute(ctx: StepContext) {
    seenWaitStates.push(ctx.waitState);
    throw new StepWaitingError("CHAP job STARTED", {
      retryAfterMs: 30_000,
      state: { lastStatus: "STARTED", checks: 1 },
    });
  },
});
registerHandler("test-permanent", {
  async execute() {
    throw new StepPermanentError("CHAP prediction job job-1 FAILURE: model crashed");
  },
});
const seenPipelineNames: Array<string | undefined> = [];
registerHandler("test-pipeline-name", {
  async execute(ctx: StepContext) {
    seenPipelineNames.push(ctx.pipelineName);
    return {};
  },
});
registerHandler("test-error", {
  async execute() {
    throw new Error("network blip");
  },
});

function setup(handlerKey: string, { updatedCount = 1 } = {}) {
  const tx = {
    stepExecution: { updateMany: vi.fn().mockResolvedValue({ count: updatedCount }) },
    outboxMessage: { create: vi.fn().mockResolvedValue({ id: "recheck" }) },
  };
  const prisma = {
    stepExecution: {
      findUnique: vi.fn().mockResolvedValue({
        ...buildMockStepExecution({ status: StepExecutionStatus.RUNNING, stepSnapshot: null }),
        step: buildMockStep({ handlerKey, name: handlerKey }),
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pipelineExecution: {
      findUnique: vi.fn().mockResolvedValue({
        id: "execution-id",
        status: PipelineExecutionStatus.AWAITING_STEP,
        context: {},
        pipeline: { name: "Malaria weekly" },
      }),
    },
    executionLog: { create: vi.fn().mockResolvedValue({}) },
    outboxMessage: { create: vi.fn().mockResolvedValue({ id: "result" }) },
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const worker = new StepWorker({
    prisma: prisma as unknown as PrismaClient,
    channel: {} as Channel,
  });
  return { worker, prisma, tx };
}

const message = { executionId: "execution-id", stepExecutionId: "step-execution-id" };

describe("StepWorker: waiting steps", () => {
  beforeEach(() => {
    seenWaitStates.length = 0;
  });

  it("keeps the attempt RUNNING and queues the same attempt again after the interval", async () => {
    const { worker, prisma, tx } = setup("test-wait");
    const before = Date.now();

    await worker.handle(message);

    expect(tx.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "step-execution-id", status: StepExecutionStatus.RUNNING },
      })
    );
    const recheck = tx.outboxMessage.create.mock.calls[0]![0].data;
    expect(recheck.destination).toBe("step.test-wait");
    expect(recheck.payload).toEqual({
      ...message,
      waitState: { lastStatus: "STARTED", checks: 1 },
    });
    expect(recheck.availableAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    // No result is published and the attempt is not finished.
    expect(prisma.outboxMessage.create).not.toHaveBeenCalled();
    expect(prisma.stepExecution.update).not.toHaveBeenCalled();
  });

  it("does not queue a re-check once the attempt has left RUNNING (e.g. cancelled)", async () => {
    const { worker, tx } = setup("test-wait", { updatedCount: 0 });

    await worker.handle(message);

    expect(tx.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("passes the wait state to the handler on a re-check, without re-logging the start", async () => {
    const { worker, prisma } = setup("test-wait");

    await worker.handle({ ...message, waitState: { lastStatus: "PENDING", checks: 3 } });

    expect(seenWaitStates).toEqual([{ lastStatus: "PENDING", checks: 3 }]);
    expect(prisma.executionLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: "Step worker executing: test-wait" }),
      })
    );
  });
});

describe("StepWorker: failures", () => {
  it("reports a permanent failure as not retryable", async () => {
    const { worker, prisma } = setup("test-permanent");

    await worker.handle(message);

    const result = prisma.outboxMessage.create.mock.calls[0]![0].data;
    expect(result.destination).toBe(STEP_RESULTS_QUEUE);
    expect(result.payload).toMatchObject({ succeeded: false, retryable: false });
  });

  it("leaves an ordinary failure retryable", async () => {
    const { worker, prisma } = setup("test-error");

    await worker.handle(message);

    const result = prisma.outboxMessage.create.mock.calls[0]![0].data;
    expect(result.payload).toMatchObject({ succeeded: false });
    expect(result.payload).not.toHaveProperty("retryable");
  });
});

describe("StepWorker: step context", () => {
  it("passes the pipeline name to queued steps", async () => {
    const { worker } = setup("test-pipeline-name");

    await worker.handle(message);

    expect(seenPipelineNames).toEqual(["Malaria weekly"]);
  });
});
