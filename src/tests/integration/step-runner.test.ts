import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, StepExecutionStatus, TaskExecutionStatus } from "@db/client.ts";
import { StepRunner } from "@/services/worker/services/runners/step.ts";
import {
  clearExecutionData,
  createTestPrisma,
  seedExecution,
  seedPipeline,
  seedStep,
} from "../utils/helpers.ts";

// ============================================================
// Mock telemetry — avoids needing a running OTel collector
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
// Handler registry — register test handlers per test
// We use a file-scoped suffix to avoid conflicts with other test files
// ============================================================

const HANDLER_KEY = "sr-test-handler";
const HANDLER_KEY_UNKNOWN = "sr-unknown-handler-DOES_NOT_EXIST";

// Lazily imported to pick up the mock above
let registerHandler: typeof import("@/services/worker/types/service.ts").registerHandler;

// ============================================================
// Test setup
// ============================================================

let prisma: PrismaClient;
let handlerExecute: any;

beforeAll(async () => {
  prisma = createTestPrisma();
  const mod = await import("@/services/worker/types/service.ts");
  registerHandler = mod.registerHandler;
  // Register once for the entire suite — uniquely keyed so no conflicts
  handlerExecute = vi.fn().mockResolvedValue({ done: true });
  try {
    registerHandler(HANDLER_KEY, { execute: handlerExecute });
  } catch {
    // Already registered from a previous run in the same module cache — ignore
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
  handlerExecute.mockReset();
  handlerExecute.mockResolvedValue({ done: true });
});

// ============================================================
// Helpers
// ============================================================

async function seedAll(handlerKey = HANDLER_KEY) {
  const pipeline = await seedPipeline(prisma);
  const step = await seedStep(prisma, pipeline.id, { handlerKey });
  const execution = await seedExecution(prisma, pipeline.id);
  return { pipeline, step, execution };
}

// ============================================================
// Tests
// ============================================================

describe("StepRunner", () => {
  describe("successful run", () => {
    it("creates StepExecution with RUNNING then updates to SUCCEEDED", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      const result = await runner.run(step, execution, 1, { input: "data" });

      expect(result.succeeded).toBe(true);
      expect(result.output).toEqual({ done: true });

      const stepExec = await prisma.stepExecution.findFirst({
        where: { executionId: execution.id, stepId: step.id },
      });
      expect(stepExec).toMatchObject({
        status: StepExecutionStatus.SUCCEEDED,
        attemptNumber: 1,
        finishedAt: expect.any(Date),
      });
      expect(stepExec?.output).toEqual({ done: true });
    });

    it("stores the input on the StepExecution record", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      await runner.run(step, execution, 1, { climateData: [1, 2, 3] });

      const stepExec = await prisma.stepExecution.findFirst({
        where: { executionId: execution.id },
      });
      expect(stepExec?.input).toEqual({ climateData: [1, 2, 3] });
    });

    it("calls the handler with correct ctx fields", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });
      let capturedCtx: unknown;
      handlerExecute.mockImplementation(async (ctx: unknown) => {
        capturedCtx = ctx;
        return { captured: true };
      });

      await runner.run(step, execution, 2, { previous: "output" });

      expect(capturedCtx).toMatchObject({
        step: { id: step.id },
        input: { previous: "output" },
        handlerConfig: {},
        pipelineContext: {},
      });
    });
  });

  describe("failed run", () => {
    it("marks StepExecution FAILED with errorMessage and errorStack", async () => {
      const { step, execution } = await seedAll();
      const boom = new Error("handler crashed");
      handlerExecute.mockRejectedValue(boom);
      const runner = new StepRunner({ prisma });

      const result = await runner.run(step, execution, 1, null);

      expect(result.succeeded).toBe(false);
      expect(result.error?.message).toBe("handler crashed");

      const stepExec = await prisma.stepExecution.findFirst({
        where: { executionId: execution.id },
      });
      expect(stepExec).toMatchObject({
        status: StepExecutionStatus.FAILED,
        errorMessage: "handler crashed",
        finishedAt: expect.any(Date),
      });
      expect(stepExec?.errorStack).toContain("handler crashed");
    });

    it("returns the error without rethrowing", async () => {
      const { step, execution } = await seedAll();
      handlerExecute.mockRejectedValue(new Error("do not rethrow"));
      const runner = new StepRunner({ prisma });

      // Should resolve (not reject)
      await expect(runner.run(step, execution, 1, null)).resolves.toMatchObject({
        succeeded: false,
        error: expect.objectContaining({ message: "do not rethrow" }),
      });
    });

    it("wraps non-Error throws in an Error", async () => {
      const { step, execution } = await seedAll();
      handlerExecute.mockRejectedValue("string error");
      const runner = new StepRunner({ prisma });

      const result = await runner.run(step, execution, 1, null);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe("string error");
    });
  });

  describe("task tracking persisted", () => {
    it("creates TaskExecution rows in correct order when handler calls ctx.tasks", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      handlerExecute.mockImplementation(
        async (ctx: import("@/services/worker/types/service.ts").StepContext) => {
          const t1 = await ctx.tasks.startTask("download", { url: "https://era5.example.com" });
          await t1.succeed({ bytes: 1024 });
          const t2 = await ctx.tasks.startTask("parse", { format: "json" });
          await t2.succeed({ records: 50 });
          return { imported: 50 };
        }
      );

      await runner.run(step, execution, 1, null);

      const tasks = await prisma.taskExecution.findMany({
        where: {
          stepExecution: { executionId: execution.id },
        },
        orderBy: { taskOrder: "asc" },
      });

      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({
        name: "download",
        taskOrder: 0,
        status: TaskExecutionStatus.SUCCEEDED,
      });
      expect(tasks[1]).toMatchObject({
        name: "parse",
        taskOrder: 1,
        status: TaskExecutionStatus.SUCCEEDED,
      });
    });

    it("marks task FAILED when task.fail is called", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      handlerExecute.mockImplementation(
        async (ctx: import("@/services/worker/types/service.ts").StepContext) => {
          const task = await ctx.tasks.startTask("risky-op");
          await task.fail(new Error("task failed"));
          throw new Error("task failed");
        }
      );

      await runner.run(step, execution, 1, null);

      const task = await prisma.taskExecution.findFirst({
        where: { stepExecution: { executionId: execution.id } },
      });
      expect(task).toMatchObject({
        status: TaskExecutionStatus.FAILED,
        errorMessage: "task failed",
        finishedAt: expect.any(Date),
      });
    });
  });

  describe("log entries written", () => {
    it("creates ExecutionLog entries scoped to the step execution", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      handlerExecute.mockImplementation(
        async (ctx: import("@/services/worker/types/service.ts").StepContext) => {
          await ctx.log("INFO", "processing data", { count: 10 });
          await ctx.log("WARN", "slow response detected");
          return null;
        }
      );

      await runner.run(step, execution, 1, null);

      const logs = await prisma.executionLog.findMany({
        where: { executionId: execution.id },
        orderBy: { loggedAt: "asc" },
      });

      const stepLogs = logs.filter(
        (l) => l.message.includes("processing data") || l.message.includes("slow response")
      );
      expect(stepLogs).toHaveLength(2);
      expect(stepLogs[0]).toMatchObject({ level: "INFO", message: "processing data" });
      expect(stepLogs[1]).toMatchObject({ level: "WARN", message: "slow response detected" });
    });

    it("task.log creates entries scoped to both step and task", async () => {
      const { step, execution } = await seedAll();
      const runner = new StepRunner({ prisma });

      handlerExecute.mockImplementation(
        async (ctx: import("@/services/worker/types/service.ts").StepContext) => {
          const task = await ctx.tasks.startTask("upload");
          await task.log("DEBUG", "uploading batch", { batchSize: 100 });
          await task.succeed();
          return null;
        }
      );

      await runner.run(step, execution, 1, null);

      const log = await prisma.executionLog.findFirst({
        where: { message: "uploading batch" },
      });
      expect(log).toMatchObject({
        level: "DEBUG",
        stepExecutionId: expect.any(String),
        taskExecutionId: expect.any(String),
      });
    });
  });

  describe("handler not found", () => {
    it("creates StepExecution then marks it FAILED with descriptive error", async () => {
      const { pipeline, execution } = await seedAll();
      // Step with a key that is NOT registered
      const step = await seedStep(prisma, pipeline.id, {
        handlerKey: HANDLER_KEY_UNKNOWN,
        stepOrder: 1,
      });
      const runner = new StepRunner({ prisma });

      const result = await runner.run(step, execution, 1, null);

      expect(result.succeeded).toBe(false);
      expect(result.error?.message).toContain(
        `No handler registered for key: "${HANDLER_KEY_UNKNOWN}"`
      );

      const stepExec = await prisma.stepExecution.findFirst({
        where: { stepId: step.id },
      });
      expect(stepExec).toMatchObject({
        status: StepExecutionStatus.FAILED,
        errorMessage: expect.stringContaining(HANDLER_KEY_UNKNOWN),
      });
    });
  });
});
