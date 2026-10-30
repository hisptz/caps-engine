import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyPolicy, ConnectorRunStatus, PipelineExecutionStatus } from "@db/client";
import { ConnectorEvaluator } from "@/services/worker/services/runners/connector.ts";
import { MAX_CONNECTOR_CHAIN_DEPTH } from "@/shared/pipeline/connectors.ts";

const CONNECTOR_RUN_ID = "run-1";
const SOURCE_EXECUTION_ID = "source-exec";
const TARGET_PIPELINE_ID = "target-pipe";
const TARGET_EXECUTION_ID = "target-exec";
const OTHERWISE_PIPELINE_ID = "otherwise-pipe";

type RunOverrides = {
  status?: ConnectorRunStatus;
  condition?: unknown;
  isActive?: boolean;
  chainDepth?: number;
  inputMapping?: Record<string, string>;
  otherwisePipelineId?: string;
};

function buildRun(overrides: RunOverrides = {}) {
  return {
    id: CONNECTOR_RUN_ID,
    status: overrides.status ?? ConnectorRunStatus.WAITING,
    sourceStatus: PipelineExecutionStatus.COMPLETED,
    sourceExecutionId: SOURCE_EXECUTION_ID,
    connector: {
      id: "connector-1",
      name: "Notify on alerts",
      isActive: overrides.isActive ?? true,
      condition: overrides.condition ?? null,
      inputMapping: overrides.inputMapping ?? { count: "step_0_output.count" },
      targetPipelineId: TARGET_PIPELINE_ID,
      otherwisePipelineId: overrides.otherwisePipelineId ?? null,
    },
    sourceExecution: {
      id: SOURCE_EXECUTION_ID,
      context: { step_0_output: { count: 4 } },
      chainDepth: overrides.chainDepth ?? 0,
    },
  };
}

function createPrisma() {
  const prisma = {
    connectorRun: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    pipeline: {
      findUnique: vi.fn().mockResolvedValue({
        id: TARGET_PIPELINE_ID,
        isActive: true,
        concurrencyPolicy: ConcurrencyPolicy.ALLOW,
      }),
    },
    pipelineExecution: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: TARGET_EXECUTION_ID }),
      update: vi.fn(),
    },
    executionLog: { create: vi.fn().mockResolvedValue({}) },
    outboxMessage: { create: vi.fn().mockResolvedValue({ id: "outbox-1" }) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}

describe("ConnectorEvaluator", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let evaluator: ConnectorEvaluator;

  beforeEach(() => {
    prisma = createPrisma();
    evaluator = new ConnectorEvaluator({ prisma: prisma as never });
  });

  it("fires: starts the target with mapped input and records the execution", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({ condition: { ">": [{ var: "context.step_0_output.count" }, 0] } })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).toHaveBeenCalledWith({
      where: { id: CONNECTOR_RUN_ID, status: ConnectorRunStatus.WAITING },
      data: {
        status: ConnectorRunStatus.FIRED,
        startedOtherwise: false,
        evaluatedAt: expect.any(Date),
      },
    });
    expect(prisma.pipelineExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pipelineId: TARGET_PIPELINE_ID,
        triggeredBy: "connector",
        chainDepth: 1,
        context: expect.objectContaining({ count: 4 }),
      }),
    });
    expect(prisma.connectorRun.update).toHaveBeenCalledWith({
      where: { id: CONNECTOR_RUN_ID },
      data: { targetExecutionId: TARGET_EXECUTION_ID },
    });
  });

  it("ends NOT_MET when the rule is false and starts nothing", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({ condition: { ">": [{ var: "context.step_0_output.count" }, 10] } })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).toHaveBeenCalledWith({
      where: { id: CONNECTOR_RUN_ID, status: ConnectorRunStatus.WAITING },
      data: expect.objectContaining({ status: ConnectorRunStatus.NOT_MET }),
    });
    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });

  it("starts the otherwise pipeline when the rule is false and one is set", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({
        condition: { ">": [{ var: "context.step_0_output.count" }, 10] },
        otherwisePipelineId: OTHERWISE_PIPELINE_ID,
      })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).toHaveBeenCalledWith({
      where: { id: CONNECTOR_RUN_ID, status: ConnectorRunStatus.WAITING },
      data: expect.objectContaining({
        status: ConnectorRunStatus.FIRED,
        startedOtherwise: true,
      }),
    });
    expect(prisma.pipeline.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHERWISE_PIPELINE_ID } })
    );
    expect(prisma.pipelineExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ pipelineId: OTHERWISE_PIPELINE_ID }),
    });
    expect(prisma.executionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executionId: SOURCE_EXECUTION_ID,
        message: expect.stringContaining("rule not met, started the otherwise pipeline"),
      }),
    });
  });

  it("still starts the target, not the otherwise pipeline, when the rule is met", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({
        condition: { ">": [{ var: "context.step_0_output.count" }, 0] },
        otherwisePipelineId: OTHERWISE_PIPELINE_ID,
      })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.pipelineExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ pipelineId: TARGET_PIPELINE_ID }),
    });
  });

  it("ends CANCELLED when the connector was deactivated", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(buildRun({ isActive: false }));

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ConnectorRunStatus.CANCELLED }),
      })
    );
    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });

  it("ends FAILED when the chain of connectors is too long", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({ chainDepth: MAX_CONNECTOR_CHAIN_DEPTH })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ConnectorRunStatus.FAILED }),
      })
    );
    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });

  it("ends SKIPPED when the target's concurrency policy refuses to start", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(buildRun());
    prisma.pipeline.findUnique.mockResolvedValue({
      id: TARGET_PIPELINE_ID,
      isActive: true,
      concurrencyPolicy: ConcurrencyPolicy.SKIP,
    });
    prisma.pipelineExecution.findFirst.mockResolvedValue({ id: "already-running" });

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
    expect(prisma.connectorRun.update).toHaveBeenCalledWith({
      where: { id: CONNECTOR_RUN_ID },
      data: { status: ConnectorRunStatus.SKIPPED, reason: expect.stringContaining("SKIP policy") },
    });
  });

  it("ignores a run that is no longer waiting (duplicate delivery)", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(
      buildRun({ status: ConnectorRunStatus.FIRED })
    );

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.connectorRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });

  it("does not start the target if another evaluator claimed the run first", async () => {
    prisma.connectorRun.findUnique.mockResolvedValue(buildRun());
    prisma.connectorRun.updateMany.mockResolvedValue({ count: 0 });

    await evaluator.handle(CONNECTOR_RUN_ID);

    expect(prisma.pipelineExecution.create).not.toHaveBeenCalled();
  });
});
