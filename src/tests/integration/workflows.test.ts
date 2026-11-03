import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PipelineExecutionStatus, type PrismaClient } from "@db/client";
import { finishExecution } from "@/shared/pipeline/finishExecution.ts";
import { ConnectorEvaluator } from "@/services/worker/services/runners/connector.ts";
import { PipelineQueries } from "@/services/api/utils/pipeline/queries.ts";
import { ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { clearExecutionData, createTestPrisma, seedPipeline, seedStep } from "../utils/helpers.ts";

// The workflow service reads the API's shared client; point it at the test database
const db = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@/services/api/utils/db.ts", () => ({
  get apiDb() {
    return db.client;
  },
}));

const { WorkflowService } = await import("@/services/api/modules/workflows/service.ts");

// ============================================================
// Workflows against a real database: one start launches the first pipelines as one run,
// and connectors carry that run on to the workflow's other pipelines.
// ============================================================

let prisma: PrismaClient;
let evaluator: ConnectorEvaluator;
let service: InstanceType<typeof WorkflowService>;

beforeAll(() => {
  prisma = createTestPrisma();
  db.client = prisma;
  evaluator = new ConnectorEvaluator({ prisma });
  service = new WorkflowService();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
});

function finish(executionId: string, pipelineId: string) {
  return prisma.$transaction((tx) =>
    finishExecution(tx, { executionId, pipelineId, status: PipelineExecutionStatus.COMPLETED })
  );
}

async function expectApiError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

/** disease + climate start together; disease -> prediction (inside); climate -> report (outside) */
async function seedWorkflow() {
  const workflow = await service.createWorkflow({ name: `wf-${Date.now()}`, isActive: true });
  const disease = await seedPipeline(prisma);
  const climate = await seedPipeline(prisma);
  const prediction = await seedPipeline(prisma);
  const report = await seedPipeline(prisma);
  for (const pipeline of [disease, climate, prediction]) {
    await service.addPipeline(workflow.id, pipeline.id);
  }
  await prisma.pipelineConnector.createMany({
    data: [
      { name: "predict", sourcePipelineId: disease.id, targetPipelineId: prediction.id },
      { name: "report", sourcePipelineId: climate.id, targetPipelineId: report.id },
    ],
  });
  return { workflow, disease, climate, prediction, report };
}

describe("workflows", () => {
  it("lists the pipelines a workflow starts with", async () => {
    const { workflow, disease, climate } = await seedWorkflow();

    const detail = await service.getWorkflow(workflow.id);

    expect(detail.pipelines).toHaveLength(3);
    expect(detail.connectors).toHaveLength(2);
    expect(detail.entryPipelineIds.sort()).toEqual([disease.id, climate.id].sort());
  });

  it("keeps a pipeline in at most one workflow", async () => {
    const { disease } = await seedWorkflow();
    const other = await service.createWorkflow({ name: `other-${Date.now()}`, isActive: true });

    await expectApiError(
      service.addPipeline(other.id, disease.id),
      ApiErrorCode.PIPELINE_IN_OTHER_WORKFLOW
    );
  });

  it("runs: starts the first pipelines together and connectors carry the run inside the workflow", async () => {
    const { workflow, disease, climate, prediction, report } = await seedWorkflow();

    const result = await service.runWorkflow(workflow.id);

    expect(result.started.map((s) => s.pipelineId).sort()).toEqual([disease.id, climate.id].sort());
    expect(result.skipped).toEqual([]);
    const started = await prisma.pipelineExecution.findMany({
      where: { workflowRunId: result.workflowRunId },
    });
    expect(started).toHaveLength(2);
    expect(started.every((e) => e.triggeredBy === "workflow")).toBe(true);
    await expect(service.getRun(result.workflowRunId)).resolves.toMatchObject({
      status: "RUNNING",
      executionCount: 2,
    });

    const diseaseExec = started.find((e) => e.pipelineId === disease.id)!;
    const climateExec = started.find((e) => e.pipelineId === climate.id)!;
    for (const runId of [
      ...(await finish(diseaseExec.id, disease.id)),
      ...(await finish(climateExec.id, climate.id)),
    ]) {
      await evaluator.handle(runId);
    }

    // The member target joins the run; the pipeline outside the workflow does not
    const predictionExec = await prisma.pipelineExecution.findFirstOrThrow({
      where: { pipelineId: prediction.id },
    });
    expect(predictionExec.workflowRunId).toBe(result.workflowRunId);
    const reportExec = await prisma.pipelineExecution.findFirstOrThrow({
      where: { pipelineId: report.id },
    });
    expect(reportExec.workflowRunId).toBeNull();

    await expect(service.getRun(result.workflowRunId)).resolves.toMatchObject({
      status: "RUNNING",
      executionCount: 3,
    });
    await finish(predictionExec.id, prediction.id);

    const run = await service.getRun(result.workflowRunId);
    expect(run.status).toBe("COMPLETED");
    expect(run.connectorRuns.map((c) => c.status).sort()).toEqual(["FIRED", "FIRED"]);
    expect(run.finishedAt).toBeInstanceOf(Date);
    const runs = await service.listRuns(workflow.id, { page: 1, pageSize: 25 });
    expect(runs.items).toEqual([
      expect.objectContaining({ id: result.workflowRunId, status: "COMPLETED" }),
    ]);
  });

  it("records first pipelines that did not start", async () => {
    const workflow = await service.createWorkflow({ name: `wf-${Date.now()}`, isActive: true });
    const off = await seedPipeline(prisma, { isActive: false });
    await service.addPipeline(workflow.id, off.id);

    const result = await service.runWorkflow(workflow.id);

    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([
      { pipelineId: off.id, pipelineName: off.name, reason: "Pipeline is inactive" },
    ]);
    await expect(service.getRun(result.workflowRunId)).resolves.toMatchObject({
      status: "SKIPPED",
      skipped: result.skipped,
    });
  });

  it("refuses to run an empty or inactive workflow", async () => {
    const empty = await service.createWorkflow({ name: `empty-${Date.now()}`, isActive: true });
    await expectApiError(service.runWorkflow(empty.id), ApiErrorCode.WORKFLOW_EMPTY);

    const { workflow } = await seedWorkflow();
    await service.updateWorkflow(workflow.id, { isActive: false });
    await expectApiError(service.runWorkflow(workflow.id), ApiErrorCode.WORKFLOW_INACTIVE);
  });

  it("works out the next scheduled run", async () => {
    const workflow = await service.createWorkflow({
      name: `scheduled-${Date.now()}`,
      isActive: true,
      cronExpr: "0 6 1 * *",
    });
    expect(workflow.nextRunAt).toBeInstanceOf(Date);

    const cleared = await service.updateWorkflow(workflow.id, { cronExpr: null });
    expect(cleared.nextRunAt).toBeNull();
  });

  it("keeps the pipelines when a workflow is deleted", async () => {
    const { workflow, disease } = await seedWorkflow();

    await service.deleteWorkflow(workflow.id);

    const kept = await prisma.pipeline.findUniqueOrThrow({ where: { id: disease.id } });
    expect(kept.workflowId).toBeNull();
  });
});

describe("duplicate pipeline", () => {
  it("copies the steps but not the workflow or schedules", async () => {
    const { disease } = await seedWorkflow();
    await seedStep(prisma, disease.id, { name: "Pull", stepOrder: 0, handlerConfig: { a: 1 } });
    await seedStep(prisma, disease.id, { name: "Upload", stepOrder: 1 });
    await prisma.pipelineSchedule.create({
      data: { pipelineId: disease.id, name: "daily", cronExpr: "0 6 * * *" },
    });

    const copy = await new PipelineQueries(prisma).duplicatePipeline(disease.id, "Disease copy");

    const full = await new PipelineQueries(prisma).getPipeline(copy.id);
    expect(full.name).toBe("Disease copy");
    expect(full.workflowId).toBeNull();
    expect(full.schedules).toEqual([]);
    expect(full.steps.map((s) => [s.name, s.stepOrder, s.handlerConfig])).toEqual([
      ["Pull", 0, { a: 1 }],
      ["Upload", 1, {}],
    ]);
  });
});
