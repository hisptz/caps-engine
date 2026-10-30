import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConnectorRunStatus,
  ConnectorTriggerOn,
  PipelineExecutionStatus,
  type PrismaClient,
} from "@db/client.ts";
import { finishExecution } from "@/shared/pipeline/finishExecution.ts";
import { ConnectorEvaluator } from "@/services/worker/services/runners/connector.ts";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import { IncomingConnectorsError, PipelineQueries } from "@/services/api/utils/pipeline/queries.ts";
import {
  clearExecutionData,
  createTestPrisma,
  seedExecution,
  seedPipeline,
} from "../utils/helpers.ts";

// ============================================================
// Pipeline connectors against a real database: finishing a source
// execution creates connector runs, and the evaluator fires them.
// ============================================================

let prisma: PrismaClient;
let evaluator: ConnectorEvaluator;

beforeAll(() => {
  prisma = createTestPrisma();
  evaluator = new ConnectorEvaluator({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
});

async function seedConnectedPipelines(connector: {
  on?: ConnectorTriggerOn;
  condition?: object;
  delayMinutes?: number;
}) {
  const source = await seedPipeline(prisma);
  const target = await seedPipeline(prisma);
  const created = await prisma.pipelineConnector.create({
    data: {
      name: "source to target",
      sourcePipelineId: source.id,
      targetPipelineId: target.id,
      on: connector.on ?? ConnectorTriggerOn.COMPLETED,
      condition: connector.condition,
      inputMapping: { alertCount: "step_0_output.count" },
      delayMinutes: connector.delayMinutes ?? 0,
    },
  });
  const execution = await seedExecution(prisma, source.id, {
    status: PipelineExecutionStatus.RUNNING,
    context: { step_0_output: { count: 3 } },
  });
  return { source, target, connector: created, execution };
}

function finish(executionId: string, pipelineId: string, status: "COMPLETED" | "FAILED") {
  return prisma.$transaction((tx) =>
    finishExecution(tx, { executionId, pipelineId, status: PipelineExecutionStatus[status] })
  );
}

describe("pipeline connectors", () => {
  it("fires: a completed source starts the target with mapped input", async () => {
    const { source, target, execution } = await seedConnectedPipelines({
      condition: { ">": [{ var: "context.step_0_output.count" }, 0] },
    });

    const [connectorRunId] = await finish(execution.id, source.id, "COMPLETED");

    const finished = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(finished.status).toBe(PipelineExecutionStatus.COMPLETED);
    const connectorMessage = await prisma.outboxMessage.findFirstOrThrow({
      where: { destination: QUEUES.PIPELINE_CONNECTORS },
    });
    expect(connectorMessage.payload).toEqual({ connectorRunId });

    await evaluator.handle(connectorRunId!);

    const run = await prisma.connectorRun.findUniqueOrThrow({ where: { id: connectorRunId } });
    expect(run.status).toBe(ConnectorRunStatus.FIRED);
    const started = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: run.targetExecutionId! },
    });
    expect(started.pipelineId).toBe(target.id);
    expect(started.triggeredBy).toBe("connector");
    expect(started.chainDepth).toBe(1);
    expect(started.context).toMatchObject({ alertCount: 3 });
    await expect(
      prisma.outboxMessage.count({
        where: {
          destination: QUEUES.PIPELINE_EXECUTIONS,
          payload: { equals: { executionId: started.id } },
        },
      })
    ).resolves.toBe(1);
  });

  it("ends NOT_MET and starts nothing when the rule is false", async () => {
    const { source, target, execution } = await seedConnectedPipelines({
      condition: { ">": [{ var: "context.step_0_output.count" }, 10] },
    });

    const [connectorRunId] = await finish(execution.id, source.id, "COMPLETED");
    await evaluator.handle(connectorRunId!);

    const run = await prisma.connectorRun.findUniqueOrThrow({ where: { id: connectorRunId } });
    expect(run.status).toBe(ConnectorRunStatus.NOT_MET);
    await expect(
      prisma.pipelineExecution.count({ where: { pipelineId: target.id } })
    ).resolves.toBe(0);
  });

  it("creates no run when the outcome does not match the connector", async () => {
    const { source, execution } = await seedConnectedPipelines({
      on: ConnectorTriggerOn.COMPLETED,
    });

    const runs = await finish(execution.id, source.id, "FAILED");

    expect(runs).toEqual([]);
    await expect(prisma.connectorRun.count()).resolves.toBe(0);
  });

  it("delays the connector message by the connector's delay", async () => {
    const { source, execution } = await seedConnectedPipelines({ delayMinutes: 15 });
    const before = Date.now();

    await finish(execution.id, source.id, "COMPLETED");

    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { destination: QUEUES.PIPELINE_CONNECTORS },
    });
    expect(message.availableAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
  });

  it("fires a connector at most once per source execution", async () => {
    const { source, execution } = await seedConnectedPipelines({ on: ConnectorTriggerOn.FINISHED });

    await finish(execution.id, source.id, "FAILED");
    // A retry revives the execution and it finishes again
    const second = await finish(execution.id, source.id, "COMPLETED");

    expect(second).toEqual([]);
    await expect(prisma.connectorRun.count()).resolves.toBe(1);
  });

  it("does not delete a pipeline a connector starts", async () => {
    const { target } = await seedConnectedPipelines({});
    const queries = new PipelineQueries(prisma);

    await expect(queries.deletePipeline(target.id)).rejects.toBeInstanceOf(IncomingConnectorsError);
  });

  it("deletes a source pipeline together with its connectors", async () => {
    const { source, execution } = await seedConnectedPipelines({});
    await finish(execution.id, source.id, "COMPLETED");
    const queries = new PipelineQueries(prisma);

    await queries.deletePipeline(source.id);

    await expect(prisma.pipelineConnector.count()).resolves.toBe(0);
    await expect(prisma.connectorRun.count()).resolves.toBe(0);
  });
});
