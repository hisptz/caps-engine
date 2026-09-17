import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn(), post: vi.fn() },
}));

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { dhis2AnalyticsRun } from "@/services/worker/services/handlers/dhis2AnalyticsRun/index.ts";

const mockGet = vi.mocked(dhis2RestClient.get);
const mockPost = vi.mocked(dhis2RestClient.post);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("dhis2-analytics-run handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPost.mockResolvedValue({
      data: {
        status: "OK",
        response: { id: "job_triggered", created: iso(Date.now()), name: "analytics" },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preflight: if analytics already running, skips trigger and polls until completed", async () => {
    const now = Date.now();
    let jobPollCount = 0;

    mockGet.mockImplementation(async (url: string) => {
      if (url === "/system/tasks/ANALYTICS_TABLE") {
        return {
          data: {
            job_running: [{ completed: false, level: "INFO", time: iso(now), message: "running" }],
          },
        };
      }
      if (url === "/system/tasks/ANALYTICS_TABLE/job_running") {
        jobPollCount++;
        return {
          data:
            jobPollCount < 2
              ? [{ completed: false, level: "INFO", time: iso(now), message: "still running" }]
              : [{ completed: true, level: "INFO", time: iso(now), message: "done" }],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        runOptions: {},
        polling: { pollIntervalMs: 250, maxAttempts: 10 },
      },
    });

    const promise = dhis2AnalyticsRun.execute(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = (await promise) as { triggered: boolean; jobId: string };

    expect(result.triggered).toBe(false);
    expect(result.jobId).toBe("job_running");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("trigger: when not running, triggers and auto-detects jobId, then completes", async () => {
    const now = Date.now();
    let tasksCallCount = 0;

    mockPost.mockResolvedValue({
      data: {
        status: "OK",
        response: { id: "job_new", created: iso(now), name: "analytics" },
      },
    });

    mockGet.mockImplementation(async (url: string) => {
      if (url === "/system/tasks/ANALYTICS_TABLE") {
        tasksCallCount++;
        // first preflight: no running
        if (tasksCallCount === 1) return { data: {} };
        // after trigger: job appears with a recent notification
        return {
          data: {
            job_new: [{ completed: false, level: "INFO", time: iso(now), message: "started" }],
          },
        };
      }
      if (url === "/system/tasks/ANALYTICS_TABLE/job_new") {
        return {
          data: [{ completed: true, level: "INFO", time: iso(now), message: "done" }],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        runOptions: { lastYears: 2 },
        polling: { pollIntervalMs: 250, maxAttempts: 10 },
      },
    });

    const promise = dhis2AnalyticsRun.execute(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = (await promise) as { triggered: boolean; jobId: string };

    expect(result.triggered).toBe(true);
    expect(result.jobId).toBe("job_new");
    expect(mockPost).toHaveBeenCalledWith(
      "/resourceTables/analytics",
      undefined,
      expect.objectContaining({
        params: expect.objectContaining({ lastYears: 2 }),
      })
    );
  });

  it("fast completion: succeeds when no incomplete job can be detected after trigger", async () => {
    let tasksCallCount = 0;

    mockPost.mockResolvedValue({ data: { status: "OK" } });

    mockGet.mockImplementation(async (url: string) => {
      if (url === "/system/tasks/ANALYTICS_TABLE") {
        tasksCallCount++;
        // preflight (empty), then after trigger still empty
        return { data: {} };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        runOptions: { lastYears: 1 },
        polling: { pollIntervalMs: 250, maxAttempts: 3 },
      },
    });

    const promise = dhis2AnalyticsRun.execute(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = (await promise) as {
      triggered: boolean;
      jobId: string | null;
      assumedCompleted?: boolean;
    };

    expect(result.triggered).toBe(true);
    expect(result.jobId).toBeNull();
    expect(result.assumedCompleted).toBe(true);
    expect(mockPost).toHaveBeenCalledOnce();
    expect(tasksCallCount).toBeGreaterThanOrEqual(2);
  });
});
