import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

const mockBunWrite = vi.fn().mockResolvedValue(0);
const mockFileJson = vi.fn();
const mockBunFile = vi.fn().mockReturnValue({ json: mockFileJson });

function stubBunForTests() {
  stubBun({ write: mockBunWrite, file: mockBunFile });
}

vi.mock("@/services/worker/utils/chap.ts", () => ({
  getPredictionResult: vi.fn(),
}));

import { getPredictionResult } from "@/services/worker/utils/chap.ts";
import { predictionDataDownload } from "@/services/worker/services/handlers/predictionDataDownload/index.ts";
import { dhis2DataUpload } from "@/services/worker/services/handlers/dhis2DataUpload/index.ts";
import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";

vi.mock("@/services/worker/utils/dhis2.ts", () => ({
  postDataValueSet: vi.fn(),
}));

const mockGetPredictionResult = vi.mocked(getPredictionResult);
const mockPostDataValueSet = vi.mocked(postDataValueSet);

function baseHandlerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataElementIds: { "0.5": "DHIS2_DE_CASES" },
    ...overrides,
  };
}

function pollOutput(overrides: Partial<{ jobId: string; result: string; status: string }> = {}) {
  return {
    jobId: "job-abc",
    result: "pred-entry-42",
    status: "finished",
    ...overrides,
  };
}

describe("predictionDataDownload", () => {
  beforeEach(() => {
    stubBunForTests();
    vi.clearAllMocks();
    mockBunWrite.mockResolvedValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when jobId is missing from input", async () => {
    const ctx = buildMockContext({
      input: { result: "r1", status: "finished" },
      handlerConfig: baseHandlerConfig(),
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(/jobId/);
  });

  it("throws when result is missing from input", async () => {
    const ctx = buildMockContext({
      input: { jobId: "job-1", status: "finished" },
      handlerConfig: baseHandlerConfig(),
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(/result/);
  });

  it("throws when dataElementIds is empty", async () => {
    const ctx = buildMockContext({
      input: pollOutput(),
      handlerConfig: baseHandlerConfig({ dataElementIds: {} }),
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow();
  });

  it("fetches prediction-entry rows and maps quantiles to DHIS2 DataValueSet file", async () => {
    mockGetPredictionResult.mockResolvedValue([
      { quantile: 0.5, orgUnit: "OU1", period: "202501", value: 12.5 },
    ]);

    const taskHandle = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: pollOutput(),
      handlerConfig: baseHandlerConfig(),
      tasks: { startTask: vi.fn().mockResolvedValue(taskHandle) },
    });

    const result = (await predictionDataDownload.execute(ctx)) as {
      jobId: string;
      filename: string;
      count: number;
    };

    expect(mockGetPredictionResult).toHaveBeenCalledWith({ resultId: "pred-entry-42" });
    expect(mockBunWrite).toHaveBeenCalledOnce();
    const [, json] = mockBunWrite.mock.calls[0]!;
    const payload = JSON.parse(json as string) as {
      dataValues: { dataElement: string; value: string; orgUnit: string; period: string }[];
    };
    expect(payload.dataValues).toHaveLength(1);
    expect(payload.dataValues[0]).toEqual({
      dataElement: "DHIS2_DE_CASES",
      orgUnit: "OU1",
      period: "202501",
      value: "13",
    });
    expect(result).toMatchObject({
      jobId: "job-abc",
      count: 1,
    });
    expect(result.filename).toMatch(
      /^chap-prediction-[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}\.json$/i
    );
    expect(taskHandle.succeed).toHaveBeenCalled();
  });

  it("throws when a CHAP quantile is not in the mapping", async () => {
    mockGetPredictionResult.mockResolvedValue([
      { quantile: 0.99, orgUnit: "OU1", period: "202501", value: 1 },
    ]);
    const taskHandle = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: pollOutput(),
      handlerConfig: baseHandlerConfig(),
      tasks: { startTask: vi.fn().mockResolvedValue(taskHandle) },
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(/Unmapped CHAP dataElement/);
    expect(taskHandle.fail).toHaveBeenCalled();
  });

  it("fails task when getPredictionResult throws", async () => {
    const boom = new Error("CHAP unavailable");
    mockGetPredictionResult.mockRejectedValue(boom);
    const taskHandle = buildMockTaskHandle();
    const ctx = buildMockContext({
      input: pollOutput(),
      handlerConfig: baseHandlerConfig(),
      tasks: { startTask: vi.fn().mockResolvedValue(taskHandle) },
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow("CHAP unavailable");
    expect(taskHandle.fail).toHaveBeenCalledWith(boom);
  });
});

describe("dhis2DataUpload filename resolution", () => {
  beforeEach(() => {
    stubBunForTests();
    vi.clearAllMocks();
    mockPostDataValueSet.mockResolvedValue({
      status: "SUCCESS",
      importCount: { imported: 1, updated: 0, ignored: 0, deleted: 0 },
    });
  });

  it("reads file using ctx.input.filename", async () => {
    const jsonPayload = {
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    };
    mockFileJson.mockResolvedValue(jsonPayload);

    const ctx = buildMockContext({
      input: { filename: "from-prev-step.json" },
      handlerConfig: {},
    });
    await dhis2DataUpload.execute(ctx);

    expect(mockBunFile).toHaveBeenCalled();
    const fileArg = mockBunFile.mock.calls[0]![0] as string;
    expect(fileArg).toContain("from-prev-step.json");
    expect(mockPostDataValueSet).toHaveBeenCalledWith(
      expect.objectContaining({ payload: jsonPayload })
    );
  });

  it("throws when prior step output omits filename", async () => {
    const ctx = buildMockContext({
      input: {},
      handlerConfig: {},
    });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/filename/);
  });

  it("ignores handlerConfig.filename if present", async () => {
    const jsonPayload = {
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    };
    mockFileJson.mockResolvedValue(jsonPayload);

    const ctx = buildMockContext({
      input: { filename: "actual-from-pipeline.json" },
      handlerConfig: { filename: "wrong.json" },
    });
    await dhis2DataUpload.execute(ctx);

    const fileArg = mockBunFile.mock.calls[0]![0] as string;
    expect(fileArg).toContain("actual-from-pipeline.json");
    expect(fileArg).not.toContain("wrong.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
