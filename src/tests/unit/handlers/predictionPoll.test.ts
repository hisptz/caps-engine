import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildMockContext,
  buildMockStepExecution,
  buildMockTaskHandle,
} from "@/tests/utils/helpers.ts";

vi.mock("@/services/worker/utils/chap.ts", () => ({
  getJobStatus: vi.fn(),
  getJobDescription: vi.fn(),
  getJobLogTail: vi.fn(),
}));

import { getJobDescription, getJobLogTail, getJobStatus } from "@/services/worker/utils/chap.ts";
import { predictionPoll } from "@/services/worker/services/handlers/predictionPoll/index.ts";
import { StepPermanentError, StepWaitingError } from "@/services/worker/types/service.ts";

const mockGetJobStatus = vi.mocked(getJobStatus);
const mockGetJobDescription = vi.mocked(getJobDescription);
const mockGetJobLogTail = vi.mocked(getJobLogTail);

function waitingContext(overrides: Parameters<typeof buildMockContext>[0] = {}) {
  return buildMockContext({
    input: { jobId: "job-1" },
    stepExecution: buildMockStepExecution({ startedAt: new Date() }),
    ...overrides,
  });
}

async function waitingFrom(promise: Promise<unknown>): Promise<StepWaitingError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StepWaitingError);
  return error as StepWaitingError;
}

describe("predictionPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobLogTail.mockResolvedValue(null);
  });

  it("succeeds when CHAP reports SUCCESS", async () => {
    mockGetJobStatus.mockResolvedValueOnce("SUCCESS");
    mockGetJobDescription.mockResolvedValueOnce({
      id: "job-1",
      type: "create_prediction",
      name: "forecast",
      status: "SUCCESS",
      start_time: null,
      end_time: null,
      result: "pred-42",
    });
    const task = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
      tasks: { startTask: vi.fn().mockResolvedValue(task) },
    });

    await expect(predictionPoll.execute(ctx)).resolves.toEqual({
      jobId: "job-1",
      status: "SUCCESS",
      result: "pred-42",
      predictionSetupId: null,
    });
  });

  it("fails permanently when CHAP reports FAILURE, with the CHAP log tail", async () => {
    mockGetJobStatus.mockResolvedValueOnce("FAILURE");
    mockGetJobDescription.mockResolvedValueOnce({
      id: "job-1",
      type: "create_prediction",
      name: "forecast",
      status: "FAILURE",
      start_time: null,
      end_time: null,
      result: "model crashed",
    });
    mockGetJobLogTail.mockResolvedValueOnce("Traceback: out of memory");
    const task = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
      tasks: { startTask: vi.fn().mockResolvedValue(task) },
    });

    const error = await predictionPoll.execute(ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepPermanentError);
    expect((error as Error).message).toContain("CHAP prediction job job-1 FAILURE: model crashed");
    expect((error as Error).message).toContain("Traceback: out of memory");
    expect(task.fail).toHaveBeenCalled();
  });

  it("fails permanently when CHAP reports REVOKED", async () => {
    mockGetJobStatus.mockResolvedValueOnce("REVOKED");
    mockGetJobDescription.mockResolvedValueOnce(null);
    const task = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
      tasks: { startTask: vi.fn().mockResolvedValue(task) },
    });

    await expect(predictionPoll.execute(ctx)).rejects.toThrow(StepPermanentError);
  });

  it("still treats legacy failed as terminal", async () => {
    mockGetJobStatus.mockResolvedValueOnce("failed");
    mockGetJobDescription.mockResolvedValueOnce(null);
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
    });

    await expect(predictionPoll.execute(ctx)).rejects.toThrow(/failed/);
  });

  it("keeps waiting while the job is STARTED, checking again after the interval", async () => {
    mockGetJobStatus.mockResolvedValue("STARTED");
    const ctx = waitingContext();

    const waiting = await waitingFrom(predictionPoll.execute(ctx));

    expect(waiting.retryAfterMs).toBe(30_000);
    expect(waiting.state).toMatchObject({ jobId: "job-1", lastStatus: "STARTED", checks: 1 });
    expect(ctx.log).toHaveBeenCalledWith(
      "INFO",
      "Waiting for CHAP prediction job",
      expect.objectContaining({ intervalSeconds: 30, timeoutHours: 6 })
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "INFO",
      "CHAP job status",
      expect.objectContaining({ status: "STARTED" })
    );
  });

  it("does not log the same status again on a re-check", async () => {
    mockGetJobStatus.mockResolvedValue("STARTED");
    const ctx = waitingContext({ waitState: { jobId: "job-1", lastStatus: "STARTED", checks: 4 } });

    const waiting = await waitingFrom(predictionPoll.execute(ctx));

    expect(waiting.state).toMatchObject({ checks: 5 });
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it("uses the configured interval", async () => {
    mockGetJobStatus.mockResolvedValue("PENDING");
    const ctx = waitingContext({ handlerConfig: { polling: { intervalSeconds: 60 } } });

    const waiting = await waitingFrom(predictionPoll.execute(ctx));

    expect(waiting.retryAfterMs).toBe(60_000);
  });

  it("fails permanently as possibly stuck once the safety timeout has passed", async () => {
    mockGetJobStatus.mockResolvedValue("STARTED");
    const ctx = waitingContext({
      stepExecution: buildMockStepExecution({ startedAt: new Date(Date.now() - 7 * 3_600_000) }),
    });

    const error = await predictionPoll.execute(ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepPermanentError);
    expect((error as Error).message).toMatch(/still "STARTED" after 6 h .* may be stuck/);
  });

  it("keeps waiting, and warns once, when CHAP cannot be reached", async () => {
    mockGetJobStatus.mockRejectedValue(new Error("ECONNREFUSED"));

    const first = waitingContext();
    const waiting = await waitingFrom(predictionPoll.execute(first));
    expect(waiting.state).toMatchObject({ statusErrors: 1 });
    expect(first.log).toHaveBeenCalledWith(
      "WARN",
      "Could not read the CHAP job status; will keep checking",
      expect.anything()
    );

    const again = waitingContext({ waitState: waiting.state });
    const stillWaiting = await waitingFrom(predictionPoll.execute(again));
    expect(stillWaiting.state).toMatchObject({ statusErrors: 2 });
    expect(again.log).not.toHaveBeenCalled();
  });

  it("fails permanently without a job id from the previous step", async () => {
    await expect(predictionPoll.execute(buildMockContext({ input: {} }))).rejects.toThrow(
      StepPermanentError
    );
  });
});
