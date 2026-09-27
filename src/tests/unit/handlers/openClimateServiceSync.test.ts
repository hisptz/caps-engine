import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { buildMockContext } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/clients/climateApi.ts", () => ({
  climateApiClient: { get: vi.fn(), post: vi.fn() },
}));

import { climateApiClient } from "@/shared/clients/climateApi.ts";
import {
  openClimateServiceSync,
  type OpenClimateServiceSyncOutput,
} from "@/services/worker/services/handlers/openClimateServiceSync/index.ts";
import { openClimateServiceSyncConfigSchema } from "@/services/worker/services/handlers/openClimateServiceSync/schemas/config.ts";

const mockGet = vi.mocked(climateApiClient.get);
const mockPost = vi.mocked(climateApiClient.post);

const polling = { pollIntervalMs: 1_000, maxAttempts: 5 };

function plan(action: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      source_dataset_id: "tpl",
      sync_kind: "temporal",
      action,
      reason: `reason_${action}`,
      message: `planned ${action}`,
      target_end_source: "default_today",
      current_end: "2026-07",
      target_end: "2026-08",
      ...extra,
    },
  };
}

function accepted(jobId: string) {
  return {
    status: 202,
    headers: { location: `/ingestions/jobs/${jobId}` },
    data: { status: "accepted" },
  };
}

function job(jobID: string, status: string, error?: { type: string; message: string }) {
  return { data: { jobID, processID: "sync", status, error: error ?? null } };
}

/** Routes GETs by URL: `/sync/{id}/plan` → plans[id], `/ingestions/jobs/{id}` → next of jobs[id]. */
function routeGets(plans: Record<string, unknown>, jobs: Record<string, unknown[]> = {}): void {
  mockGet.mockImplementation(async (url: string) => {
    const planMatch = url.match(/^\/sync\/([^/]+)\/plan$/);
    if (planMatch) {
      const p = plans[decodeURIComponent(planMatch[1]!)];
      if (p instanceof Error) throw p;
      return p;
    }
    const jobMatch = url.match(/^\/ingestions\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const queue = jobs[jobMatch[1]!]!;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

async function run(handlerConfig: Record<string, unknown>) {
  const ctx = buildMockContext({ handlerConfig });
  const promise = openClimateServiceSync.execute(ctx);
  // Keep the rejection observed while timers advance; the test awaits it afterwards.
  promise.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  return { ctx, promise };
}

describe("open-climate-service-sync handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips datasets the planner reports as up to date without starting a sync", async () => {
    routeGets({ temp: plan("no_op", { current_end: "2026-08" }) });

    const { promise } = await run({ datasetIds: ["temp"], polling });
    const result = (await promise) as OpenClimateServiceSyncOutput;

    expect(mockPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ synced: 0, upToDate: 1, failed: 0 });
    expect(result.datasets[0]).toMatchObject({
      datasetId: "temp",
      outcome: "up-to-date",
      coveredUntil: "2026-08",
    });
  });

  it("queues a sync and polls its job until it succeeds", async () => {
    routeGets(
      { temp: plan("append") },
      { job_1: [job("job_1", "running"), job("job_1", "successful")] }
    );
    mockPost.mockResolvedValue(accepted("job_1"));

    const { promise } = await run({ datasetIds: ["temp"], end: "2026-08-31", polling });
    const result = (await promise) as OpenClimateServiceSyncOutput;

    expect(mockPost).toHaveBeenCalledWith(
      "/sync/temp",
      { end: "2026-08-31", publish: true },
      { headers: { Prefer: "respond-async" } }
    );
    expect(result.datasets[0]).toMatchObject({
      outcome: "synced",
      action: "append",
      coveredUntil: "2026-07",
      syncedUntil: "2026-08",
      jobId: "job_1",
    });
  });

  it("syncs each dataset as its own task", async () => {
    routeGets(
      { temp: plan("no_op"), precip: plan("append") },
      { job_p: [job("job_p", "successful")] }
    );
    mockPost.mockResolvedValue(accepted("job_p"));

    const { ctx, promise } = await run({ datasetIds: ["temp", "precip"], polling });
    const result = (await promise) as OpenClimateServiceSyncOutput;

    expect(vi.mocked(ctx.tasks.startTask).mock.calls.map(([name]) => name)).toEqual([
      "sync:temp",
      "sync:precip",
    ]);
    expect(result).toMatchObject({ synced: 1, upToDate: 1, failed: 0 });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("fails the step when a sync job fails, naming the dataset and the job's error", async () => {
    routeGets(
      { temp: plan("no_op"), precip: plan("append") },
      { job_p: [job("job_p", "failed", { type: "DownloadError", message: "CHIRPS timed out" })] }
    );
    mockPost.mockResolvedValue(accepted("job_p"));

    const { promise } = await run({ datasetIds: ["temp", "precip"], polling });

    await expect(promise).rejects.toThrow(
      /1 of 2 climate dataset\(s\) failed to sync — precip: Sync job job_p for "precip" ended as failed: CHIRPS timed out/
    );
  });

  it("continues past a failed dataset when onFailure is continue", async () => {
    routeGets({ temp: plan("no_op"), precip: new Error("socket hang up") });

    const { ctx, promise } = await run({
      datasetIds: ["temp", "precip"],
      onFailure: "continue",
      polling,
    });
    const result = (await promise) as OpenClimateServiceSyncOutput;

    expect(result).toMatchObject({ upToDate: 1, failed: 1 });
    expect(result.datasets[1]).toMatchObject({ datasetId: "precip", outcome: "failed" });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("continuing with the data already available"),
      expect.anything()
    );
  });

  it("explains a conflict as a sync that is already running", async () => {
    routeGets({ temp: plan("append") });
    mockPost.mockRejectedValue(
      new AxiosError("conflict", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 409,
        statusText: "Conflict",
        data: { detail: "sync in progress" },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
    );

    const { promise } = await run({ datasetIds: ["temp"], polling });

    await expect(promise).rejects.toThrow(/already running/);
  });

  it("keeps polling through transient job-status errors", async () => {
    routeGets({ temp: plan("append") }, { job_1: [new Error("502"), job("job_1", "successful")] });
    mockPost.mockResolvedValue(accepted("job_1"));

    const { promise } = await run({ datasetIds: ["temp"], polling });
    const result = (await promise) as OpenClimateServiceSyncOutput;

    expect(result.synced).toBe(1);
  });

  it("times out with a message saying the job keeps running", async () => {
    routeGets({ temp: plan("append") }, { job_1: [job("job_1", "running")] });
    mockPost.mockResolvedValue(accepted("job_1"));

    const { promise } = await run({ datasetIds: ["temp"], polling });

    await expect(promise).rejects.toThrow(/keeps running in the Open Climate Service/);
  });
});

describe("open-climate-service-sync config", () => {
  it("defaults to failing on error and to polling under the consumer timeout", () => {
    const config = openClimateServiceSyncConfigSchema.parse({ datasetIds: ["temp"] });
    expect(config.onFailure).toBe("fail");
    expect(config.polling.pollIntervalMs * config.polling.maxAttempts).toBeLessThan(30 * 60_000);
  });

  it("rejects an empty or duplicated dataset list", () => {
    expect(openClimateServiceSyncConfigSchema.safeParse({ datasetIds: [] }).success).toBe(false);
    expect(
      openClimateServiceSyncConfigSchema.safeParse({ datasetIds: ["temp", "temp"] }).success
    ).toBe(false);
  });

  it("accepts only a real YYYY-MM-DD end date", () => {
    const parse = (end: string) =>
      openClimateServiceSyncConfigSchema.safeParse({ datasetIds: ["temp"], end }).success;
    expect(parse("2026-08-31")).toBe(true);
    expect(parse("2026-08")).toBe(false);
    expect(parse("2026-13-01")).toBe(false);
    expect(parse("aug 2026")).toBe(false);
  });
});
