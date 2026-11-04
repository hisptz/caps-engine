import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MergeRunStatus,
  MergeTriggerRule,
  PipelineExecutionStatus,
  type PrismaClient,
} from "@db/client";
import { finishExecution } from "@/shared/pipeline/finishExecution.ts";
import { MergeEvaluator } from "@/services/worker/services/runners/merge.ts";
import { ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { clearExecutionData, createTestPrisma, seedPipeline } from "../utils/helpers.ts";

// The API services read the shared client; point them at the test database
const db = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@/services/api/utils/db.ts", () => ({
  get apiDb() {
    return db.client;
  },
}));

const { WorkflowService } = await import("@/services/api/modules/workflows/service.ts");
const { MergeService } = await import("@/services/api/modules/merges/service.ts");

// ============================================================
// Merges against a real database: inside a workflow run, wait for several pipelines,
// then start one more.
// ============================================================

let prisma: PrismaClient;
let evaluator: MergeEvaluator;
let workflows: InstanceType<typeof WorkflowService>;
let merges: InstanceType<typeof MergeService>;

beforeAll(() => {
  prisma = createTestPrisma();
  db.client = prisma;
  evaluator = new MergeEvaluator({ prisma });
  workflows = new WorkflowService();
  merges = new MergeService();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
});

async function expectApiError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

/** disease + climate start together; the merge starts prediction once both are done */
async function seedMergeWorkflow(
  merge: {
    triggerRule?: MergeTriggerRule;
    condition?: object;
  } = {}
) {
  const workflow = await workflows.createWorkflow({ name: `wf-${Date.now()}`, isActive: true });
  const disease = await seedPipeline(prisma, { name: `disease-${Date.now()}` });
  const climate = await seedPipeline(prisma, { name: `climate-${Date.now()}` });
  const prediction = await seedPipeline(prisma, { name: `prediction-${Date.now()}` });
  for (const pipeline of [disease, climate, prediction]) {
    await workflows.addPipeline(workflow.id, pipeline.id);
  }
  const created = await merges.createMerge({
    name: "predict when both are in",
    workflowId: workflow.id,
    sourcePipelineIds: [disease.id, climate.id],
    targetPipelineId: prediction.id,
    triggerRule: merge.triggerRule ?? MergeTriggerRule.ALL_SUCCEEDED,
    timeoutMinutes: 60,
    condition: merge.condition,
    isActive: true,
  });
  return { workflow, disease, climate, prediction, merge: created };
}

async function startRun(workflowId: string) {
  const { workflowRunId } = await workflows.runWorkflow(workflowId);
  const executions = await prisma.pipelineExecution.findMany({ where: { workflowRunId } });
  return { workflowRunId, executions };
}

async function finish(
  execution: { id: string; pipelineId: string },
  status: "COMPLETED" | "FAILED",
  context?: object
) {
  if (context) {
    await prisma.pipelineExecution.update({ where: { id: execution.id }, data: { context } });
  }
  await prisma.$transaction((tx) =>
    finishExecution(tx, {
      executionId: execution.id,
      pipelineId: execution.pipelineId,
      status: PipelineExecutionStatus[status],
    })
  );
  const run = await prisma.mergeRun.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  await evaluator.handle(run.id);
  return prisma.mergeRun.findUniqueOrThrow({ where: { id: run.id } });
}

describe("merges", () => {
  it("waits for every source, then starts the target in the same workflow run", async () => {
    const { workflow, disease, climate, prediction } = await seedMergeWorkflow();
    const { workflowRunId, executions } = await startRun(workflow.id);
    expect(executions.map((e) => e.pipelineId).sort()).toEqual([disease.id, climate.id].sort());

    const afterFirst = await finish(
      executions.find((e) => e.pipelineId === disease.id)!,
      "COMPLETED"
    );
    expect(afterFirst.status).toBe(MergeRunStatus.WAITING);
    await expect(workflows.getRun(workflowRunId)).resolves.toMatchObject({ status: "RUNNING" });

    const afterBoth = await finish(
      executions.find((e) => e.pipelineId === climate.id)!,
      "COMPLETED"
    );
    expect(afterBoth.status).toBe(MergeRunStatus.FIRED);
    const started = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: afterBoth.targetExecutionId! },
    });
    expect(started).toMatchObject({
      pipelineId: prediction.id,
      triggeredBy: "merge",
      workflowRunId,
      chainDepth: 1,
    });

    const detail = await workflows.getRun(workflowRunId);
    expect(detail.mergeRuns).toEqual([
      expect.objectContaining({ status: MergeRunStatus.FIRED, arrivals: expect.any(Array) }),
    ]);
  });

  it("fails as soon as a source fails under All succeeded", async () => {
    const { workflow, climate } = await seedMergeWorkflow();
    const { executions } = await startRun(workflow.id);

    const run = await finish(executions.find((e) => e.pipelineId === climate.id)!, "FAILED");

    expect(run.status).toBe(MergeRunStatus.FAILED);
    expect(run.reason).toMatch(/^Did not succeed: climate-/);
  });

  it("continues after a failure under All done", async () => {
    const { workflow, disease, climate } = await seedMergeWorkflow({
      triggerRule: MergeTriggerRule.ALL_DONE,
    });
    const { executions } = await startRun(workflow.id);

    await finish(executions.find((e) => e.pipelineId === climate.id)!, "FAILED");
    const run = await finish(executions.find((e) => e.pipelineId === disease.id)!, "COMPLETED");

    expect(run.status).toBe(MergeRunStatus.FIRED);
  });

  it("checks results from every source", async () => {
    const { workflow, disease, climate } = await seedMergeWorkflow({
      condition: {
        and: [
          { ">": [{ var: "context.stepOutputs.pull.count" }, 0] },
          { ">": [{ var: "context.stepOutputs.download.count" }, 0] },
        ],
      },
    });
    const { executions } = await startRun(workflow.id);

    await finish(executions.find((e) => e.pipelineId === disease.id)!, "COMPLETED", {
      stepOutputs: { pull: { count: 12 } },
    });
    const run = await finish(executions.find((e) => e.pipelineId === climate.id)!, "COMPLETED", {
      stepOutputs: { download: { count: 0 } },
    });

    expect(run.status).toBe(MergeRunStatus.NOT_MET);
  });

  it("times out, naming the pipeline that did not finish", async () => {
    const { workflow, disease, climate } = await seedMergeWorkflow();
    const { executions } = await startRun(workflow.id);
    const run = await finish(executions.find((e) => e.pipelineId === disease.id)!, "COMPLETED");

    await evaluator.handle(run.id, new Date(run.deadlineAt.getTime() + 1000));

    const ended = await prisma.mergeRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(ended.status).toBe(MergeRunStatus.TIMED_OUT);
    expect(ended.reason).toBe(`Did not finish in time: ${climate.name}`);
  });

  it("lists the merges a pipeline is part of", async () => {
    const { disease, prediction, merge } = await seedMergeWorkflow();
    const outside = await seedPipeline(prisma);

    for (const pipeline of [disease, prediction]) {
      const listed = await merges.listMerges({ pipelineId: pipeline.id });
      expect(listed.map((m) => m.id)).toEqual([merge.id]);
      expect(listed[0]!.workflow).toMatchObject({ name: expect.stringMatching(/^wf-/) });
    }
    await expect(merges.listMerges({ pipelineId: outside.id })).resolves.toEqual([]);
  });

  it("does not start the run with the pipeline a merge starts", async () => {
    const { workflow, disease, climate } = await seedMergeWorkflow();

    const detail = await workflows.getWorkflow(workflow.id);

    expect(detail.entryPipelineIds.sort()).toEqual([disease.id, climate.id].sort());
    expect(detail.merges).toHaveLength(1);
  });

  it("refuses merges that do not fit the workflow", async () => {
    const { workflow, disease, climate, prediction } = await seedMergeWorkflow();
    const outside = await seedPipeline(prisma);
    const base = {
      name: "bad",
      workflowId: workflow.id,
      triggerRule: MergeTriggerRule.ALL_SUCCEEDED,
      timeoutMinutes: 60,
      isActive: true,
    };

    await expectApiError(
      merges.createMerge({
        ...base,
        sourcePipelineIds: [disease.id, climate.id],
        targetPipelineId: disease.id,
      }),
      ApiErrorCode.MERGE_INVALID
    );
    await expectApiError(
      merges.createMerge({
        ...base,
        sourcePipelineIds: [disease.id, outside.id],
        targetPipelineId: prediction.id,
      }),
      ApiErrorCode.MERGE_INVALID
    );
    // prediction -> disease would close a loop with the existing merge
    await expectApiError(
      merges.createMerge({
        ...base,
        sourcePipelineIds: [prediction.id, climate.id],
        targetPipelineId: disease.id,
      }),
      ApiErrorCode.MERGE_CREATES_CYCLE
    );
    await expectApiError(
      workflows.removePipeline(workflow.id, climate.id),
      ApiErrorCode.PIPELINE_IN_MERGE
    );
  });
});
