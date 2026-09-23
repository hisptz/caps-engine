import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "@/tests/utils/helpers.ts";

vi.mock("@/services/worker/utils/chap.ts", () => ({
  getJobStatus: vi.fn(),
  getJobDescription: vi.fn(),
}));

import { getJobDescription, getJobStatus } from "@/services/worker/utils/chap.ts";
import { predictionPoll } from "@/services/worker/services/handlers/predictionPoll/index.ts";

const mockGetJobStatus = vi.mocked(getJobStatus);
const mockGetJobDescription = vi.mocked(getJobDescription);

describe("predictionPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("fails when CHAP reports FAILURE", async () => {
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
    const task = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
      tasks: { startTask: vi.fn().mockResolvedValue(task) },
    });

    await expect(predictionPoll.execute(ctx)).rejects.toThrow(/FAILURE/);
    expect(task.fail).toHaveBeenCalled();
  });

  it("fails when CHAP reports REVOKED", async () => {
    mockGetJobStatus.mockResolvedValueOnce("REVOKED");
    mockGetJobDescription.mockResolvedValueOnce(null);
    const task = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
      tasks: { startTask: vi.fn().mockResolvedValue(task) },
    });

    await expect(predictionPoll.execute(ctx)).rejects.toThrow(/REVOKED/);
  });

  it("still treats legacy failed as terminal", async () => {
    mockGetJobStatus.mockResolvedValueOnce("failed");
    mockGetJobDescription.mockResolvedValueOnce(null);
    const ctx = buildMockContext({
      input: { jobId: "job-1" },
    });

    await expect(predictionPoll.execute(ctx)).rejects.toThrow(/failed/);
  });
});
