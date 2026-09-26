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
  getPredictionSetup: vi.fn(),
}));

import { getPredictionResult, getPredictionSetup } from "@/services/worker/utils/chap.ts";
import { predictionDataDownload } from "@/services/worker/services/handlers/predictionDataDownload/index.ts";
import { dhis2DataUpload } from "@/services/worker/services/handlers/dhis2DataUpload/index.ts";
import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";

vi.mock("@/services/worker/utils/dhis2.ts", () => ({
  postDataValueSet: vi.fn(),
}));

const mockGetPredictionResult = vi.mocked(getPredictionResult);
const mockGetPredictionSetup = vi.mocked(getPredictionSetup);
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

    expect(mockGetPredictionResult).toHaveBeenCalledWith({
      resultId: "pred-entry-42",
      quantiles: expect.arrayContaining(["0.5"]),
    });
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
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(/Unmapped CHAP quantile/);
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

  it("defaults importStrategy to CREATE_AND_UPDATE when config omits it", async () => {
    mockFileJson.mockResolvedValue({
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    });

    const ctx = buildMockContext({
      input: { filename: "from-prev-step.json" },
      handlerConfig: {},
    });
    await dhis2DataUpload.execute(ctx);

    expect(mockPostDataValueSet).toHaveBeenCalledWith(
      expect.objectContaining({ importStrategy: "CREATE_AND_UPDATE" })
    );
  });

  it("passes the configured importStrategy to DHIS2", async () => {
    mockFileJson.mockResolvedValue({
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    });

    const ctx = buildMockContext({
      input: { filename: "from-prev-step.json" },
      handlerConfig: { importStrategy: "UPDATE" },
    });
    await dhis2DataUpload.execute(ctx);

    expect(mockPostDataValueSet).toHaveBeenCalledWith(
      expect.objectContaining({ importStrategy: "UPDATE" })
    );
  });

  it("rejects an unknown importStrategy", async () => {
    const ctx = buildMockContext({
      input: { filename: "from-prev-step.json" },
      handlerConfig: { importStrategy: "DELETE" },
    });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/handlerConfig/);
    expect(mockPostDataValueSet).not.toHaveBeenCalled();
  });

  it("throws when prior step output omits filename", async () => {
    const ctx = buildMockContext({
      input: {},
      handlerConfig: {},
    });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/filename/);
  });

  it("fails with DHIS2 conflicts when the import status is ERROR", async () => {
    mockFileJson.mockResolvedValue({
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    });
    mockPostDataValueSet.mockResolvedValue({
      status: "ERROR",
      importCount: { imported: 0, updated: 0, ignored: 1, deleted: 0 },
      conflicts: [{ object: "de", value: "Data element not found" }],
    });

    const ctx = buildMockContext({ input: { filename: "f.json" }, handlerConfig: {} });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/de: Data element not found/);
  });

  it("returns real counts and logs conflicts on WARNING", async () => {
    mockFileJson.mockResolvedValue({
      dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
    });
    mockPostDataValueSet.mockResolvedValue({
      status: "WARNING",
      importCount: { imported: 5, updated: 2, ignored: 1, deleted: 0 },
      conflicts: [{ object: "ou", value: "Org unit not in hierarchy" }],
    });

    const ctx = buildMockContext({ input: { filename: "f.json" }, handlerConfig: {} });
    const result = await dhis2DataUpload.execute(ctx);

    expect(result).toEqual({ status: "WARNING", imported: 5, updated: 2, ignored: 1, deleted: 0 });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringMatching(/conflicts/),
      expect.objectContaining({ conflicts: ["ou: Org unit not in hierarchy"] })
    );
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

describe("predictionDataDownload quantile mapping fallback", () => {
  beforeEach(() => {
    stubBunForTests();
    vi.clearAllMocks();
    mockBunWrite.mockResolvedValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupWithTargets(quantileTargets: Array<{ quantile: string; dataElementId: string }>) {
    mockGetPredictionSetup.mockResolvedValue({
      id: 3,
      name: "1st Prediction Disease",
      quantileTargets,
    } as unknown as Awaited<ReturnType<typeof getPredictionSetup>>);
  }

  it("uses the prediction setup's quantile targets when the config has no mapping", async () => {
    setupWithTargets([{ quantile: "0.5", dataElementId: "DE_FROM_SETUP" }]);
    mockGetPredictionResult.mockResolvedValue([
      { quantile: "0.5", orgUnit: "OU1", period: "202609", value: 12.4 },
    ] as unknown as Awaited<ReturnType<typeof getPredictionResult>>);

    const ctx = buildMockContext({
      input: { ...pollOutput(), predictionSetupId: 3 },
      handlerConfig: {},
    });

    await predictionDataDownload.execute(ctx);

    expect(mockGetPredictionSetup).toHaveBeenCalledWith(3);
    expect(mockGetPredictionResult).toHaveBeenCalledWith({
      resultId: "pred-entry-42",
      quantiles: ["0.5"],
    });
    const [, json] = mockBunWrite.mock.calls[0]!;
    const payload = JSON.parse(json as string) as {
      dataValues: { dataElement: string; value: string }[];
    };
    expect(payload.dataValues).toEqual([
      { dataElement: "DE_FROM_SETUP", orgUnit: "OU1", period: "202609", value: "12" },
    ]);
  });

  it("prefers an explicit config mapping over the setup's targets", async () => {
    setupWithTargets([{ quantile: "0.5", dataElementId: "DE_FROM_SETUP" }]);
    mockGetPredictionResult.mockResolvedValue([
      { quantile: "0.5", orgUnit: "OU1", period: "202609", value: 1 },
    ] as unknown as Awaited<ReturnType<typeof getPredictionResult>>);

    const ctx = buildMockContext({
      input: { ...pollOutput(), predictionSetupId: 3 },
      handlerConfig: baseHandlerConfig(),
    });

    await predictionDataDownload.execute(ctx);

    expect(mockGetPredictionSetup).not.toHaveBeenCalled();
  });

  it("fails clearly when there is neither a mapping nor a prediction setup", async () => {
    const ctx = buildMockContext({ input: pollOutput(), handlerConfig: {} });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(/no quantile mapping/);
  });

  it("translates the Modeling app's quantile names into the numbers CHAP answers with", async () => {
    setupWithTargets([
      { quantile: "median", dataElementId: "DE_MEDIAN" },
      { quantile: "quantile_high", dataElementId: "DE_HIGH" },
      { quantile: "outbreak_indicator", dataElementId: "DE_ALERT" },
    ]);
    mockGetPredictionResult.mockResolvedValue([
      { quantile: 0.5, orgUnit: "OU1", period: "202609", value: 4.4 },
      { quantile: 0.9, orgUnit: "OU1", period: "202609", value: 9.6 },
    ] as unknown as Awaited<ReturnType<typeof getPredictionResult>>);

    const ctx = buildMockContext({
      input: { ...pollOutput(), predictionSetupId: 3 },
      handlerConfig: {},
    });

    await predictionDataDownload.execute(ctx);

    expect(mockGetPredictionResult).toHaveBeenCalledWith({
      resultId: "pred-entry-42",
      quantiles: ["0.5", "0.9"],
    });
    const [, json] = mockBunWrite.mock.calls[0]!;
    const payload = JSON.parse(json as string) as {
      dataValues: { dataElement: string; value: string }[];
    };
    expect(payload.dataValues.map((dv) => dv.dataElement)).toEqual(["DE_MEDIAN", "DE_HIGH"]);
  });

  it("fails when the setup has only targets that are not forecast quantiles", async () => {
    setupWithTargets([{ quantile: "outbreak_indicator", dataElementId: "DE_ALERT" }]);
    const ctx = buildMockContext({
      input: { ...pollOutput(), predictionSetupId: 3 },
      handlerConfig: {},
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(
      /no forecast quantile targets/
    );
  });

  it("fails when the setup itself has no quantile targets", async () => {
    setupWithTargets([]);
    const ctx = buildMockContext({
      input: { ...pollOutput(), predictionSetupId: 3 },
      handlerConfig: {},
    });
    await expect(predictionDataDownload.execute(ctx)).rejects.toThrow(
      /no forecast quantile targets/
    );
  });
});
