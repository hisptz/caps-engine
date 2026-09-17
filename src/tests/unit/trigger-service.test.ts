import { ConcurrencyPolicy, PipelineExecutionStatus } from "@db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TriggerService } from "@/services/scheduler/trigger-service.ts";
import { QUEUES } from "@/services/worker/constants/monitor.ts";

const PIPELINE_ID = "22222222-2222-4111-8111-222222222222";
const EXECUTION_ID = "33333333-3333-4111-8111-333333333333";

function createPrisma() {
  return {
    pipeline: {
      findUnique: vi.fn(),
    },
    pipelineExecution: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    executionLog: {
      create: vi.fn(),
    },
    outboxMessage: {
      create: vi.fn().mockResolvedValue({ id: "outbox-1" }),
    },
    pipelineSchedule: {
      update: vi.fn(),
    },
  };
}

describe("TriggerService", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: TriggerService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new TriggerService(prisma as never);
  });

  it("creates a pending execution and outbox message", async () => {
    prisma.pipeline.findUnique.mockResolvedValue({
      id: PIPELINE_ID,
      isActive: true,
      concurrencyPolicy: ConcurrencyPolicy.SKIP,
    });
    prisma.pipelineExecution.findFirst.mockResolvedValue(null);
    prisma.pipelineExecution.create.mockResolvedValue({ id: EXECUTION_ID });

    const result = await service.triggerPipeline(PIPELINE_ID, {
      triggeredBy: "scheduler",
      scheduleId: "11111111-1111-4111-8111-111111111111",
      scheduleInputContext: { steps: { "step-a": { orgUnit: "abc" } } },
      context: { scheduleName: "Daily" },
    });

    expect(result).toEqual({ executionId: EXECUTION_ID, skipped: false });
    expect(prisma.pipelineSchedule.update).not.toHaveBeenCalled();
    expect(prisma.outboxMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destination: QUEUES.PIPELINE_EXECUTIONS,
        }),
      })
    );
  });

  it("skips when an active execution exists and policy is SKIP", async () => {
    prisma.pipeline.findUnique.mockResolvedValue({
      id: PIPELINE_ID,
      isActive: true,
      concurrencyPolicy: ConcurrencyPolicy.SKIP,
    });
    prisma.pipelineExecution.findFirst.mockResolvedValue({
      id: EXECUTION_ID,
      status: PipelineExecutionStatus.RUNNING,
    });

    const result = await service.triggerPipeline(PIPELINE_ID, { triggeredBy: "scheduler" });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain(EXECUTION_ID);
    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });

  it("skips inactive pipelines", async () => {
    prisma.pipeline.findUnique.mockResolvedValue({
      id: PIPELINE_ID,
      isActive: false,
      concurrencyPolicy: ConcurrencyPolicy.ALLOW,
    });

    const result = await service.triggerPipeline(PIPELINE_ID, { triggeredBy: "api" });

    expect(result).toEqual({
      executionId: "",
      skipped: true,
      skipReason: "Pipeline is inactive",
    });
  });
});
