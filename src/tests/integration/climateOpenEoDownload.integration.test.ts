import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "../utils/helpers.ts";
import { stubBun } from "../utils/bun.ts";

vi.mock("@/shared/clients/openeo.ts", () => ({
  getOpenEoJobResults: vi.fn(),
  downloadOpenEoJobResult: vi.fn(),
  resolveResultFilename: vi.fn(),
}));

const mockBunWrite = vi.fn().mockResolvedValue(0);

import { climateOpenEoDownload } from "@/services/worker/services/handlers/climateOpenEoDownload/index.ts";
import {
  downloadOpenEoJobResult,
  getOpenEoJobResults,
  resolveResultFilename,
} from "@/shared/clients/openeo.ts";

const mockGetResults = vi.mocked(getOpenEoJobResults);
const mockResolveFilename = vi.mocked(resolveResultFilename);
const mockDownload = vi.mocked(downloadOpenEoJobResult);

const dataValueSet = {
  dataValues: [
    {
      dataElement: "AbCdEfGhIjK",
      period: "202601",
      orgUnit: "OU_ALPHA",
      value: "12.5",
    },
  ],
};

describe("climateOpenEoDownload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBunWrite.mockResolvedValue(0);
    stubBun({ write: mockBunWrite });
    mockGetResults.mockResolvedValue({
      assets: { "result.dhis2.json": { href: "/jobs/job-123/results/result.dhis2.json" } },
    });
    mockResolveFilename.mockReturnValue("result.dhis2.json");
    mockDownload.mockResolvedValue(dataValueSet);
  });

  it("downloads DataValueSet and writes output file", async () => {
    const taskHandles = [buildMockTaskHandle(), buildMockTaskHandle()];
    let callIndex = 0;
    const ctx = buildMockContext({
      input: { jobId: "job-123", status: "finished" },
      tasks: {
        startTask: vi.fn().mockImplementation(() => Promise.resolve(taskHandles[callIndex++])),
      },
    });

    const result = (await climateOpenEoDownload.execute(ctx)) as {
      jobId: string;
      filename: string;
      count: number;
    };

    expect(result.jobId).toBe("job-123");
    expect(result.count).toBe(1);
    expect(result.filename).toMatch(/^climate-openeo-/);
    expect(mockDownload).toHaveBeenCalledWith("job-123", "result.dhis2.json");
    expect(mockBunWrite).toHaveBeenCalledOnce();
  });

  it("requires jobId from previous step", async () => {
    const ctx = buildMockContext({ input: { status: "finished" } });
    await expect(climateOpenEoDownload.execute(ctx)).rejects.toThrow("requires { jobId }");
  });

  it("fails when result is not a valid DataValueSet", async () => {
    mockDownload.mockResolvedValue({ invalid: true });
    const taskHandles = [buildMockTaskHandle()];
    const ctx = buildMockContext({
      input: { jobId: "job-123", status: "finished" },
      tasks: {
        startTask: vi.fn().mockResolvedValue(taskHandles[0]),
      },
    });

    await expect(climateOpenEoDownload.execute(ctx)).rejects.toThrow("not a valid DataValueSet");
  });
});
