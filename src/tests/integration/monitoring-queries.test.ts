import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PipelineExecutionStatus, PrismaClient, StepExecutionStatus } from "@db/client.ts";
import { MonitoringQueries } from "@/services/api/utils/monitoring/queries.ts";
import {
  clearExecutionData,
  createTestPrisma,
  seedExecution,
  seedPipeline,
  seedStep,
} from "../utils/helpers.ts";

// ============================================================
// MonitoringQueries integration tests
// Run against DATABASE_URL_TEST or DATABASE_URL.
// ============================================================

let prisma: PrismaClient;
let queries: MonitoringQueries;

beforeAll(() => {
  prisma = createTestPrisma();
  queries = new MonitoringQueries(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
});

// ============================================================
// Helpers
// ============================================================

async function seedWithStepAndLogs() {
  const pipeline = await seedPipeline(prisma);
  const step = await seedStep(prisma, pipeline.id, { handlerKey: "test-handler" });
  const execution = await seedExecution(prisma, pipeline.id, {
    status: PipelineExecutionStatus.RUNNING,
  });
  const stepExec = await prisma.stepExecution.create({
    data: {
      executionId: execution.id,
      stepId: step.id,
      attemptNumber: 1,
      status: StepExecutionStatus.RUNNING,
      startedAt: new Date(),
    },
  });
  const task = await prisma.taskExecution.create({
    data: {
      stepExecutionId: stepExec.id,
      name: "download-data",
      taskOrder: 0,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
  await prisma.executionLog.createMany({
    data: [
      { executionId: execution.id, level: "INFO", message: "pipeline started", metadata: {} },
      {
        executionId: execution.id,
        stepExecutionId: stepExec.id,
        level: "INFO",
        message: "step started",
        metadata: {},
      },
      {
        executionId: execution.id,
        stepExecutionId: stepExec.id,
        taskExecutionId: task.id,
        level: "DEBUG",
        message: "task started",
        metadata: {},
      },
    ],
  });
  return { pipeline, step, execution, stepExec, task };
}

// ============================================================
// getExecutionDetail
// ============================================================

describe("MonitoringQueries.getExecutionDetail", () => {
  it("returns execution with nested stepExecutions, taskExecutions, and logs", async () => {
    const { execution } = await seedWithStepAndLogs();

    const detail = await queries.getExecutionDetail(execution.id);

    expect(detail.id).toBe(execution.id);
    expect(detail.stepExecutions).toHaveLength(1);
    expect(detail.stepExecutions[0]!.taskExecutions).toHaveLength(1);
    expect(detail.logs).toHaveLength(3);
    expect(detail.pipeline).toMatchObject({ id: expect.any(String) });
  });

  it("includes step definition on each stepExecution", async () => {
    const { execution } = await seedWithStepAndLogs();

    const detail = await queries.getExecutionDetail(execution.id);
    const stepExec = detail.stepExecutions[0]!;

    expect(stepExec.step).toMatchObject({ handlerKey: "test-handler" });
  });

  it("orders stepExecutions by createdAt asc and taskExecutions by taskOrder asc", async () => {
    const { execution, stepExec } = await seedWithStepAndLogs();

    // Add a second task
    await prisma.taskExecution.create({
      data: {
        stepExecutionId: stepExec.id,
        name: "upload-data",
        taskOrder: 1,
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    const detail = await queries.getExecutionDetail(execution.id);
    const tasks = detail.stepExecutions[0]!.taskExecutions;

    expect(tasks[0]!.taskOrder).toBeLessThanOrEqual(tasks[1]!.taskOrder);
  });

  it("throws when executionId does not exist", async () => {
    await expect(queries.getExecutionDetail("non-existent-id-abc")).rejects.toThrow();
  });
});

// ============================================================
// getStepAttempts
// ============================================================

describe("MonitoringQueries.getStepAttempts", () => {
  it("returns all attempts for a step ordered by attemptNumber asc", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id);

    await prisma.stepExecution.createMany({
      data: [
        {
          executionId: execution.id,
          stepId: step.id,
          attemptNumber: 3,
          status: "FAILED",
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: step.id,
          attemptNumber: 1,
          status: "FAILED",
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: step.id,
          attemptNumber: 2,
          status: "FAILED",
          startedAt: new Date(),
        },
      ],
    });

    const attempts = await queries.getStepAttempts(execution.id, step.id);

    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
  });

  it("returns empty array when no attempts exist for step", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id);

    const attempts = await queries.getStepAttempts(execution.id, step.id);
    expect(attempts).toHaveLength(0);
  });

  it("includes taskExecutions on each attempt", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id);
    const execution = await seedExecution(prisma, pipeline.id);

    const stepExec = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: "FAILED",
        startedAt: new Date(),
      },
    });
    await prisma.taskExecution.create({
      data: {
        stepExecutionId: stepExec.id,
        name: "task-1",
        taskOrder: 0,
        status: "SUCCEEDED",
        startedAt: new Date(),
      },
    });

    const attempts = await queries.getStepAttempts(execution.id, step.id);
    expect(attempts[0]!.taskExecutions).toHaveLength(1);
  });
});

// ============================================================
// getDashboardSummary
// ============================================================

describe("MonitoringQueries.getDashboardSummary", () => {
  it("last24h counts reflect seeded execution statuses", async () => {
    const pipeline = await seedPipeline(prisma);

    await Promise.all([
      seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.COMPLETED }),
      seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.COMPLETED }),
      seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.FAILED }),
      seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.RUNNING }),
    ]);

    const summary = await queries.getDashboardSummary();

    expect(summary.last24h.completed).toBeGreaterThanOrEqual(2);
    expect(summary.last24h.failed).toBeGreaterThanOrEqual(1);
    expect(summary.last24h.running).toBeGreaterThanOrEqual(1);
    expect(summary.last24h.total).toBeGreaterThanOrEqual(4);
  });

  it("stuckExecutions only includes AWAITING_STEP executions older than 10 minutes", async () => {
    const pipeline = await seedPipeline(prisma);

    // Create a recent AWAITING_STEP execution (should NOT appear as stuck)
    const recentExec = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    // Create an old AWAITING_STEP execution (should appear as stuck)
    const oldExec = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    // Manually set updatedAt to 15 minutes ago using raw SQL
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    await prisma.$executeRaw`UPDATE pipeline_executions SET "updatedAt" = ${fifteenMinutesAgo} WHERE id = ${oldExec.id}`;

    const summary = await queries.getDashboardSummary();

    const stuckIds = summary.stuckExecutions.map((e) => e.id);
    expect(stuckIds).toContain(oldExec.id);
    expect(stuckIds).not.toContain(recentExec.id);
  });

  it("returns recentFailures with pipeline name included", async () => {
    const pipeline = await seedPipeline(prisma, { name: "my-test-pipeline" });
    await seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.FAILED });

    const summary = await queries.getDashboardSummary();

    const failure = summary.recentFailures.find((f) => f.pipelineId === pipeline.id);
    expect(failure).toBeDefined();
    expect(failure?.pipeline.name).toBe("my-test-pipeline");
  });
});

// ============================================================
// listExecutions
// ============================================================

describe("MonitoringQueries.listExecutions", () => {
  it("pagination: returns correct slice and total", async () => {
    const pipeline = await seedPipeline(prisma);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.COMPLETED })
      )
    );

    const page1 = await queries.listExecutions({ page: 1, pageSize: 2 });
    expect(page1.executions).toHaveLength(2);
    expect(page1.pagination.total).toBeGreaterThanOrEqual(5);
    expect(page1.pagination.pages).toBeGreaterThanOrEqual(3);

    const page2 = await queries.listExecutions({ page: 2, pageSize: 2 });
    expect(page2.executions).toHaveLength(2);
    // No overlap between pages
    const page1Ids = new Set(page1.executions.map((e) => e.id));
    expect(page2.executions.every((e) => !page1Ids.has(e.id))).toBe(true);
  });

  it("status filter returns only matching executions", async () => {
    const pipeline = await seedPipeline(prisma);
    await seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.COMPLETED });
    await seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.FAILED });

    const result = await queries.listExecutions({
      status: PipelineExecutionStatus.FAILED,
    });

    expect(result.executions.every((e) => e.status === PipelineExecutionStatus.FAILED)).toBe(true);
  });

  it("pipelineId filter returns only executions for that pipeline", async () => {
    const pipelineA = await seedPipeline(prisma);
    const pipelineB = await seedPipeline(prisma);
    await seedExecution(prisma, pipelineA.id);
    await seedExecution(prisma, pipelineB.id);

    const result = await queries.listExecutions({ pipelineId: pipelineA.id });

    expect(result.executions.every((e) => e.pipelineId === pipelineA.id)).toBe(true);
  });

  it("returns executions ordered by createdAt desc", async () => {
    const pipeline = await seedPipeline(prisma);
    await seedExecution(prisma, pipeline.id);
    await seedExecution(prisma, pipeline.id);
    await seedExecution(prisma, pipeline.id);

    const result = await queries.listExecutions({ pipelineId: pipeline.id });

    const dates = result.executions.map((e) => e.createdAt.getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it("includes pipeline name on each execution", async () => {
    const pipeline = await seedPipeline(prisma, { name: "named-pipeline" });
    await seedExecution(prisma, pipeline.id);

    const result = await queries.listExecutions({ pipelineId: pipeline.id });

    expect(result.executions[0]?.pipeline.name).toBe("named-pipeline");
  });
});

// ============================================================
// getTopFailingSteps
// ============================================================

describe("MonitoringQueries.getTopFailingSteps", () => {
  it("returns steps ordered by failure count descending", async () => {
    const pipeline = await seedPipeline(prisma);
    const stepA = await seedStep(prisma, pipeline.id, { name: "step-A", stepOrder: 0 });
    const stepB = await seedStep(prisma, pipeline.id, { name: "step-B", stepOrder: 1 });
    const execution = await seedExecution(prisma, pipeline.id);

    // stepB fails 3 times, stepA fails 1 time
    await prisma.stepExecution.createMany({
      data: [
        {
          executionId: execution.id,
          stepId: stepA.id,
          attemptNumber: 1,
          status: "FAILED",
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: stepB.id,
          attemptNumber: 1,
          status: "FAILED",
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: stepB.id,
          attemptNumber: 2,
          status: "FAILED",
          startedAt: new Date(),
        },
        {
          executionId: execution.id,
          stepId: stepB.id,
          attemptNumber: 3,
          status: "FAILED",
          startedAt: new Date(),
        },
      ],
    });

    const result = await queries.getTopFailingSteps({ days: 7, limit: 10 });

    const nameOrder = result.map((r) => r.stepName);
    const stepBIdx = nameOrder.indexOf("step-B");
    const stepAIdx = nameOrder.indexOf("step-A");
    expect(stepBIdx).toBeLessThan(stepAIdx);
    expect(result.find((r) => r.stepName === "step-B")!.failureCount).toBe(3);
  });

  it("excludes SUCCEEDED step executions from failure counts", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, { name: "healthy-step" });
    const execution = await seedExecution(prisma, pipeline.id);

    await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: "SUCCEEDED",
        startedAt: new Date(),
      },
    });

    const result = await queries.getTopFailingSteps({ days: 7 });
    expect(result.find((r) => r.stepName === "healthy-step")).toBeUndefined();
  });

  it("respects the days parameter", async () => {
    const pipeline = await seedPipeline(prisma);
    const step = await seedStep(prisma, pipeline.id, { name: "old-failed-step" });
    const execution = await seedExecution(prisma, pipeline.id);

    const stepExec = await prisma.stepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        attemptNumber: 1,
        status: "FAILED",
        startedAt: new Date(),
      },
    });

    // Move this step execution outside the days window (8 days ago)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE step_executions SET "createdAt" = ${eightDaysAgo} WHERE id = ${stepExec.id}`;

    const result = await queries.getTopFailingSteps({ days: 7 });
    expect(result.find((r) => r.stepName === "old-failed-step")).toBeUndefined();
  });
});

// ============================================================
// getDailyTrends
// ============================================================

describe("MonitoringQueries.getDailyTrends", () => {
  it("returns rows with date, status, and count", async () => {
    const pipeline = await seedPipeline(prisma);
    await seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.COMPLETED });
    await seedExecution(prisma, pipeline.id, { status: PipelineExecutionStatus.FAILED });

    const rows = await queries.getDailyTrends({ days: 7 });

    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(rows[0]).toMatchObject({
        date: expect.any(String),
        status: expect.any(String),
        count: expect.any(Number),
      });
    }
  });

  it("respects the days parameter and excludes older records", async () => {
    const pipeline = await seedPipeline(prisma);
    const oldExec = await seedExecution(prisma, pipeline.id, {
      status: PipelineExecutionStatus.COMPLETED,
    });

    // Move the execution 40 days into the past
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE pipeline_executions SET "createdAt" = ${fortyDaysAgo} WHERE id = ${oldExec.id}`;

    const rows30 = await queries.getDailyTrends({ days: 30 });
    // The 40-day-old record should not appear in 30-day window
    const countForOldDate = rows30.filter(
      (r) => Math.abs(new Date(r.date).getTime() - fortyDaysAgo.getTime()) < 24 * 60 * 60 * 1000
    );
    expect(countForOldDate).toHaveLength(0);
  });
});
