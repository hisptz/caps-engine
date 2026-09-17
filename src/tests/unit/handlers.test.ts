import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "../utils/helpers.ts";

// ============================================================
// Handler registry unit tests
// All tests are pure — no database, no queue.
// ============================================================

// Unique key counter to avoid duplicate registrations across tests in the same process
let keyCounter = 0;
function uniqueKey(prefix = "test-handler"): string {
  return `${prefix}-${Date.now()}-${++keyCounter}`;
}

describe("handler registry", () => {
  // Re-import fresh registry per describe to isolate module state
  let registerHandler: (
    key: string,
    handler: import("@/services/worker/types/service.ts").StepHandler
  ) => void;
  let resolveHandler: (key: string) => import("@/services/worker/types/service.ts").StepHandler;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/services/worker/types/service.ts");
    registerHandler = mod.registerHandler;
    resolveHandler = mod.resolveHandler;
  });

  it("resolves a handler that was registered", () => {
    const key = uniqueKey();
    const handler = { execute: vi.fn() };
    registerHandler(key, handler);
    expect(resolveHandler(key)).toBe(handler);
  });

  it("throws a descriptive error for an unknown key", () => {
    const key = uniqueKey("unknown");
    expect(() => resolveHandler(key)).toThrow(`No handler registered for key: "${key}"`);
  });

  it("lists registered keys in the error message", () => {
    const key = uniqueKey("known");
    registerHandler(key, { execute: vi.fn() });
    const unknownKey = uniqueKey("unknown");
    expect(() => resolveHandler(unknownKey)).toThrow(key);
  });

  it("throws on duplicate registration", () => {
    const key = uniqueKey("dup");
    registerHandler(key, { execute: vi.fn() });
    expect(() => registerHandler(key, { execute: vi.fn() })).toThrow(
      `Handler already registered for key: ${key}`
    );
  });
});

describe("handler execute contract", () => {
  let registerHandler: (
    key: string,
    handler: import("@/services/worker/types/service.ts").StepHandler
  ) => void;
  let resolveHandler: (key: string) => import("@/services/worker/types/service.ts").StepHandler;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/services/worker/types/service.ts");
    registerHandler = mod.registerHandler;
    resolveHandler = mod.resolveHandler;
  });

  it("handler receives ctx.input correctly", async () => {
    const key = uniqueKey();
    let capturedInput: unknown;
    registerHandler(key, {
      async execute(ctx) {
        capturedInput = ctx.input;
        return null;
      },
    });
    const ctx = buildMockContext({ input: { foo: "bar" } });
    await resolveHandler(key).execute(ctx);
    expect(capturedInput).toEqual({ foo: "bar" });
  });

  it("handler receives ctx.handlerConfig correctly", async () => {
    const key = uniqueKey();
    let capturedConfig: unknown;
    registerHandler(key, {
      async execute(ctx) {
        capturedConfig = ctx.handlerConfig;
        return null;
      },
    });
    const ctx = buildMockContext({ handlerConfig: { apiUrl: "https://example.com" } });
    await resolveHandler(key).execute(ctx);
    expect(capturedConfig).toEqual({ apiUrl: "https://example.com" });
  });

  it("handler receives ctx.pipelineContext correctly", async () => {
    const key = uniqueKey();
    let capturedCtx: unknown;
    registerHandler(key, {
      async execute(ctx) {
        capturedCtx = ctx.pipelineContext;
        return null;
      },
    });
    const ctx = buildMockContext({ pipelineContext: { step_0_output: { orgUnits: ["OU1"] } } });
    await resolveHandler(key).execute(ctx);
    expect(capturedCtx).toEqual({ step_0_output: { orgUnits: ["OU1"] } });
  });

  it("ctx.log calls are captured with correct level and message", async () => {
    const key = uniqueKey();
    const logFn = vi.fn().mockResolvedValue(undefined);
    registerHandler(key, {
      async execute(ctx) {
        await ctx.log("INFO", "starting handler", { step: "one" });
        await ctx.log("WARN", "something odd");
        return null;
      },
    });
    const ctx = buildMockContext({ log: logFn });
    await resolveHandler(key).execute(ctx);
    expect(logFn).toHaveBeenCalledTimes(2);
    expect(logFn).toHaveBeenNthCalledWith(1, "INFO", "starting handler", { step: "one" });
    expect(logFn).toHaveBeenNthCalledWith(2, "WARN", "something odd");
  });

  it("task tracking: startTask called in order, succeed called, taskExecution exposed", async () => {
    const key = uniqueKey();
    const taskHandle = {
      taskExecution: {
        id: "task-exec-id",
        stepExecutionId: "step-exec-id",
        name: "fetch-data",
        taskOrder: 0,
        status: "RUNNING" as const,
        input: null,
        output: null,
        errorMessage: null,
        errorStack: null,
        startedAt: new Date(),
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      log: vi.fn().mockResolvedValue(undefined),
      succeed: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const startTaskFn = vi.fn().mockResolvedValue(taskHandle);
    registerHandler(key, {
      async execute(ctx) {
        const task = await ctx.tasks.startTask("fetch-data", { url: "https://example.com" });
        await task.log("INFO", "fetching");
        await task.succeed({ records: 42 });
        return { records: 42 };
      },
    });
    const ctx = buildMockContext({ tasks: { startTask: startTaskFn } });
    await resolveHandler(key).execute(ctx);

    expect(startTaskFn).toHaveBeenCalledOnce();
    expect(startTaskFn).toHaveBeenCalledWith("fetch-data", { url: "https://example.com" });
    expect(taskHandle.log).toHaveBeenCalledWith("INFO", "fetching");
    expect(taskHandle.succeed).toHaveBeenCalledWith({ records: 42 });
  });

  it("task.fail propagates error out of the handler", async () => {
    const key = uniqueKey();
    const boom = new Error("task exploded");
    const taskHandle = {
      taskExecution: {
        id: "t",
        stepExecutionId: "s",
        name: "n",
        taskOrder: 0,
        status: "RUNNING" as const,
        input: null,
        output: null,
        errorMessage: null,
        errorStack: null,
        startedAt: new Date(),
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      log: vi.fn().mockResolvedValue(undefined),
      succeed: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const startTaskFn = vi.fn().mockResolvedValue(taskHandle);
    registerHandler(key, {
      async execute(ctx) {
        const task = await ctx.tasks.startTask("risky-op");
        await task.fail(boom);
        throw boom; // handler re-throws after calling fail
      },
    });
    const ctx = buildMockContext({ tasks: { startTask: startTaskFn } });
    await expect(resolveHandler(key).execute(ctx)).rejects.toThrow("task exploded");
    expect(taskHandle.fail).toHaveBeenCalledWith(boom);
  });

  it("thrown Error propagates out of execute", async () => {
    const key = uniqueKey();
    registerHandler(key, {
      async execute() {
        throw new Error("handler blew up");
      },
    });
    const ctx = buildMockContext();
    await expect(resolveHandler(key).execute(ctx)).rejects.toThrow("handler blew up");
  });

  it("returning undefined is valid and does not throw", async () => {
    const key = uniqueKey();
    registerHandler(key, {
      async execute() {
        return undefined;
      },
    });
    const ctx = buildMockContext();
    await expect(resolveHandler(key).execute(ctx)).resolves.toBeUndefined();
  });

  it("concrete fetch-based handler: mocks globalThis.fetch and returns processed output", async () => {
    const key = uniqueKey("fetch-handler");
    const fakeResponse = { orgUnits: [{ id: "OU1" }, { id: "OU2" }] };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(fakeResponse),
    });
    vi.stubGlobal("fetch", mockFetch);

    registerHandler(key, {
      async execute(ctx) {
        const url = (ctx.handlerConfig as { url: string }).url;
        const res = await fetch(url);
        const data = (await res.json()) as { orgUnits: { id: string }[] };
        return { count: data.orgUnits.length, ids: data.orgUnits.map((u) => u.id) };
      },
    });

    const ctx = buildMockContext({
      handlerConfig: { url: "https://dhis2.example.com/api/organisationUnits" },
    });
    const result = await resolveHandler(key).execute(ctx);

    expect(mockFetch).toHaveBeenCalledWith("https://dhis2.example.com/api/organisationUnits");
    expect(result).toEqual({ count: 2, ids: ["OU1", "OU2"] });
  });
});
