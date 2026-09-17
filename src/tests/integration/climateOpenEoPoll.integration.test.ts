import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "../utils/helpers.ts";

vi.mock("@/shared/clients/openeo.ts", () => ({
  getOpenEoJob: vi.fn(),
  TERMINAL_OPENEO_JOB_STATUSES: new Set(["finished", "error", "canceled"]),
  SUCCESS_OPENEO_JOB_STATUS: "finished",
}));

import { climateOpenEoPoll } from "@/services/worker/services/handlers/climateOpenEoPoll/index.ts";
import { getOpenEoJob } from "@/shared/clients/openeo.ts";

const mockGetJob = vi.mocked(getOpenEoJob);

describe("climateOpenEoPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJob.mockResolvedValue({ id: "job-123", status: "finished" });
  });

  it("polls until job is finished and returns jobId and status", async () => {
    const taskHandles = [buildMockTaskHandle()];
    const ctx = buildMockContext({
      input: { jobId: "job-123" },
      tasks: {
        startTask: vi.fn().mockResolvedValue(taskHandles[0]),
      },
    });

    const result = (await climateOpenEoPoll.execute(ctx)) as { jobId: string; status: string };

    expect(result).toEqual({ jobId: "job-123", status: "finished" });
    expect(mockGetJob).toHaveBeenCalled();
  });

  it("requires jobId from previous step", async () => {
    const ctx = buildMockContext({ input: {} });
    await expect(climateOpenEoPoll.execute(ctx)).rejects.toThrow("requires { jobId }");
  });

  it("fails when job ends in error", async () => {
    mockGetJob.mockResolvedValue({ id: "job-123", status: "error", logs: "processing failed" });
    const taskHandles = [buildMockTaskHandle()];
    const ctx = buildMockContext({
      input: { jobId: "job-123" },
      tasks: {
        startTask: vi.fn().mockResolvedValue(taskHandles[0]),
      },
    });

    await expect(climateOpenEoPoll.execute(ctx)).rejects.toThrow("processing failed");
  });
});
