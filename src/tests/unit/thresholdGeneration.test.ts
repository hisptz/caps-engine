import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn(), post: vi.fn() },
}));

const mockBunWrite = vi.fn().mockResolvedValue(0);
beforeEach(() => {
  stubBun({ write: mockBunWrite });
});

// ── Module imports (after mocks are declared) ─────────────────────────────────

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { thresholdGeneration } from "@/services/worker/services/handlers/thresholdGeneration/index.ts";
import { thresholdGenerationConfigSchema } from "@/services/worker/services/handlers/thresholdGeneration/schemas/config.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockGet = vi.mocked(dhis2RestClient.get);

/** Minimal valid handlerConfig covering all required fields. */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgUnit: { ids: ["OU1", "OU2"] },
    period: { years: ["2023"], periodType: "Monthly", yearsToInclude: 2 },
    dataElementIds: ["DE1"],
    outputDataElementId: "DE_OUT",
    ...overrides,
  };
}

/**
 * Build a mock analytics response for the given list of (orgUnit, period) pairs,
 * each with the given value.
 */
function analyticsResponse(rows: { ou: string; pe: string; dx: string; value: number }[]) {
  return {
    data: {
      headers: [{ name: "dx" }, { name: "pe" }, { name: "ou" }, { name: "value" }],
      rows: rows.map((r) => [r.dx, r.pe, r.ou, String(r.value)]),
    },
  };
}

/** Build a paginated org units response. */
function orgUnitPage(ids: string[], page = 1, pageCount = 1) {
  return {
    data: {
      organisationUnits: ids.map((id) => ({ id })),
      pager: { page, pageCount },
    },
  };
}

function analyticsGetCalls() {
  return mockGet.mock.calls.filter((c) => String(c[0]) === "/analytics");
}

function firstAnalyticsParams(): URLSearchParams {
  const call = analyticsGetCalls()[0];
  if (!call?.[1]) {
    throw new Error("expected at least one GET /analytics call");
  }
  return (call[1] as { params: URLSearchParams }).params;
}

function analyticsPeriodDimension(params: URLSearchParams): string {
  const dimension = params.getAll("dimension").find((d) => d.startsWith("pe:"));
  if (!dimension) throw new Error("expected pe dimension in analytics params");
  return dimension;
}

function allAnalyticsPeriodDimensions(): string {
  return analyticsGetCalls()
    .map((c) => analyticsPeriodDimension((c[1] as { params: URLSearchParams }).params))
    .join(";");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(analyticsResponse([]));
  mockBunWrite.mockResolvedValue(0);
});

// ── Config validation ─────────────────────────────────────────────────────────

describe("config validation", () => {
  it("throws when orgUnit is missing entirely", async () => {
    const ctx = buildMockContext({ handlerConfig: { ...baseConfig(), orgUnit: undefined } });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when period.years is missing", async () => {
    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        period: { periodType: "Monthly", yearsToInclude: 2 },
      },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when period.years is an empty array", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), period: { years: [], periodType: "Monthly" } },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when period.periodType is invalid", async () => {
    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        period: { years: ["2023"], periodType: "Biweekly" },
      },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when calculationMethod is invalid", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), calculationMethod: "p75" },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("accepts WHO calculation methods in calculationMethod", () => {
    for (const method of [
      "C-SUM",
      "C-SUM SD",
      "C-SUM + 1.96SD",
      "75th percentile",
      "25th percentile",
    ] as const) {
      expect(() =>
        thresholdGenerationConfigSchema.parse({ ...baseConfig(), calculationMethod: method })
      ).not.toThrow();
    }
  });

  it("throws when outputs has duplicate calculationMethod", async () => {
    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        outputDataElementId: undefined,
        outputs: [
          { calculationMethod: "C-SUM", outputDataElementId: "DE_A" },
          { calculationMethod: "C-SUM", outputDataElementId: "DE_B" },
        ],
      },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow(/duplicate calculationMethod/);
  });

  it("throws when neither outputs nor outputDataElementId is provided", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), outputDataElementId: undefined },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow(
      /outputDataElementId is required/
    );
  });

  it("throws when dataElementIds is missing", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), dataElementIds: undefined },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when outputDataElementId is missing", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), outputDataElementId: undefined },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow();
  });

  it("throws when no orgUnit selector is set", async () => {
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: {} },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow(
      /at least one of ids, levels, or groups/
    );
  });
});

// ── Org unit resolution ───────────────────────────────────────────────────────

describe("org unit resolution", () => {
  it("resolves union when multiple orgUnit selectors are set", async () => {
    mockGet
      .mockResolvedValueOnce(orgUnitPage(["OU_LEVEL"]))
      .mockResolvedValueOnce(orgUnitPage(["OU_GROUP"]))
      .mockResolvedValue(analyticsResponse([]));

    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        orgUnit: { ids: ["OU1"], levels: [3], groups: ["GROUP1"] },
      },
    });
    await thresholdGeneration.execute(ctx);

    expect(mockGet.mock.calls.some((c) => String(c[0]).includes("organisationUnits"))).toBe(true);
  });

  it("uses orgUnit.ids directly without calling dhis2RestClient.get for org units", async () => {
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);
    // dhis2RestClient.get should be called only for analytics, not for org units
    for (const call of mockGet.mock.calls) {
      expect(String(call[0])).not.toContain("organisationUnits");
    }
  });

  it("fetches org units by level when orgUnit.levels is set", async () => {
    mockGet
      .mockResolvedValueOnce(orgUnitPage(["OU1", "OU2"])) // org units page 1
      .mockResolvedValue(analyticsResponse([])); // analytics

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { levels: [3] } },
    });
    await thresholdGeneration.execute(ctx);

    const orgUnitCall = mockGet.mock.calls.find((c) => String(c[0]).includes("organisationUnits"));
    expect(orgUnitCall).toBeDefined();
    expect(orgUnitCall![1]).toMatchObject({ params: expect.objectContaining({ level: "3" }) });
  });

  it("fetches org units by level in a single request (paging disabled)", async () => {
    mockGet
      .mockResolvedValueOnce(orgUnitPage(["OU1", "OU2"]))
      .mockResolvedValue(analyticsResponse([]));

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { levels: [2] } },
    });
    await thresholdGeneration.execute(ctx);

    const ouCalls = mockGet.mock.calls.filter((c) => String(c[0]).includes("organisationUnits"));
    expect(ouCalls).toHaveLength(1);
    expect(ouCalls[0]![1]).toMatchObject({ params: expect.objectContaining({ paging: "false" }) });
  });

  it("fetches org units by group when orgUnit.groups is set", async () => {
    mockGet.mockResolvedValueOnce(orgUnitPage(["OU1"])).mockResolvedValue(analyticsResponse([]));

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { groups: ["GROUP1"] } },
    });
    await thresholdGeneration.execute(ctx);

    const orgUnitCall = mockGet.mock.calls.find((c) => String(c[0]).includes("organisationUnits"));
    expect(orgUnitCall![1]).toMatchObject({
      params: expect.objectContaining({ filter: "organisationUnitGroups.id:eq:GROUP1" }),
    });
  });

  it("fails task 1 and rethrows when org unit API call fails", async () => {
    const boom = new Error("DHIS2 unavailable");
    mockGet.mockRejectedValueOnce(boom);

    const task1Handle = buildMockTaskHandle();
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { levels: [3] } },
      tasks: { startTask: vi.fn().mockResolvedValue(task1Handle) },
    });

    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow("DHIS2 unavailable");
    expect(task1Handle.fail).toHaveBeenCalledWith(boom);
  });

  it("throws 'No org units found' when level returns empty list", async () => {
    mockGet.mockResolvedValueOnce(orgUnitPage([]));

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { levels: [3] } },
    });
    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow("No org units found");
  });
});

// ── Analytics fetch ───────────────────────────────────────────────────────────

describe("analytics fetch", () => {
  it("calls analytics API with correct dimension parameters", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    expect(analyticsGetCalls().length).toBeGreaterThan(0);
    const params = firstAnalyticsParams();
    expect(params.get("filter")).toMatch(/^dx:DE1(;|$)/);
    expect(analyticsPeriodDimension(params)).toMatch(/^pe:/);
    expect(params.getAll("dimension").some((d) => d.startsWith("ou:"))).toBe(true);
    expect(params.get("aggregationType")).toBe("SUM");
    expect(params.get("skipMeta")).toBe("true");
  });

  it("batches org units in groups of 50 (75 org units → 2 analytics calls)", async () => {
    const orgUnitIds = Array.from({ length: 75 }, (_, i) => `OU${i}`);
    mockGet.mockResolvedValue(analyticsResponse([]));

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), orgUnit: { ids: orgUnitIds } },
    });
    await thresholdGeneration.execute(ctx);

    // Two OU batches × one period-year batch for this config
    expect(analyticsGetCalls().length).toBeGreaterThanOrEqual(2);
    const ouDimensions = analyticsGetCalls().map((c) =>
      (c[1] as { params: URLSearchParams }).params
        .getAll("dimension")
        .find((d) => d.startsWith("ou:"))
    );
    expect(ouDimensions.some((d) => d && d.replace(/^ou:/, "").split(";").length >= 50)).toBe(true);
  });

  it("fails task 2 and rethrows when analytics API call fails", async () => {
    const boom = new Error("analytics timeout");
    mockGet.mockRejectedValueOnce(boom);

    const task1Handle = buildMockTaskHandle();
    const resolvePeriodsHandle = buildMockTaskHandle();
    const task2Handle = buildMockTaskHandle();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(task1Handle)
      .mockResolvedValueOnce(resolvePeriodsHandle)
      .mockResolvedValueOnce(task2Handle);

    const ctx = buildMockContext({
      handlerConfig: baseConfig(),
      tasks: { startTask },
    });

    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow("analytics timeout");
    expect(task2Handle.fail).toHaveBeenCalledWith(boom);
  });

  it("succeeds with zero DataValues when analytics returns no rows", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const result = (await thresholdGeneration.execute(ctx)) as { count: number };
    expect(result.count).toBe(0);
  });
});

// ── Threshold calculation ─────────────────────────────────────────────────────

describe("threshold calculation", () => {
  it("produces a DataValue for each org unit × sub-period that has historical data", async () => {
    // Config: 1 year (2023), Monthly, 2 org units, yearsToInclude=2
    // Historical periods for Jan 2023 = [202201, 202101]
    // Provide data for OU1 in 202201 and 202101 only
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const result = (await thresholdGeneration.execute(ctx)) as { count: number };

    // Only OU1/202301 should get a DataValue (OU2 has no data)
    expect(result.count).toBe(1);
  });

  it("sums values across multiple dataElements for the same (orgUnit, period)", async () => {
    // Two data elements contributing to the same historical period
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE2", pe: "202201", ou: "OU1", value: 5 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
        { dx: "DE2", pe: "202101", ou: "OU1", value: 10 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), dataElementIds: ["DE1", "DE2"] },
    });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { value: string }[] };
    // mean + 2SD of [15, 30] (summed values per period)
    const m = (15 + 30) / 2; // 22.5
    const sd = Math.sqrt(((15 - m) ** 2 + (30 - m) ** 2) / 2); // 7.5
    const expected = m + 2 * sd; // 37.5
    expect(parseFloat(payload.dataValues[0]!.value)).toBe(Math.round(expected));
  });

  it("uses outputDataElementId as the dataElement on every output DataValue", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { dataElement: string }[] };
    expect(payload.dataValues[0]!.dataElement).toBe("DE_OUT");
  });

  it("sets the output period to the target sub-period (not the historical period)", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { period: string }[] };
    // Target sub-period for Jan 2023 is "202301", not the historical "202201"
    expect(payload.dataValues[0]!.period).toBe("202301");
  });

  it("skips org units with no historical data", async () => {
    // Only OU1 has data; OU2 has none
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { orgUnit: string }[] };
    const orgUnits = payload.dataValues.map((dv) => dv.orgUnit);
    expect(orgUnits.every((ou) => ou === "OU1")).toBe(true);
    expect(orgUnits).not.toContain("OU2");
  });

  it("applies the selected calculation method correctly (mean)", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), calculationMethod: "mean" },
    });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { value: string }[] };
    expect(parseFloat(payload.dataValues[0]!.value)).toBeCloseTo(15, 2); // mean([10,20])
  });

  it("calls task3.succeed (not fail) on the normal empty-data path", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));

    const task1Handle = buildMockTaskHandle();
    const resolvePeriodsHandle = buildMockTaskHandle();
    const task2Handle = buildMockTaskHandle();
    const task3Handle = buildMockTaskHandle();
    const task4Handle = buildMockTaskHandle();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(task1Handle)
      .mockResolvedValueOnce(resolvePeriodsHandle)
      .mockResolvedValueOnce(task2Handle)
      .mockResolvedValueOnce(task3Handle)
      .mockResolvedValueOnce(task4Handle);

    const ctx = buildMockContext({
      handlerConfig: baseConfig(),
      tasks: { startTask },
    });
    await thresholdGeneration.execute(ctx);
    expect(task3Handle.succeed).toHaveBeenCalled();
    expect(task3Handle.fail).not.toHaveBeenCalled();
  });
});

// ── File write ────────────────────────────────────────────────────────────────

describe("file write", () => {
  it("writes to OUTPUTS_DIR with an autogenerated threshold-*.json name", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    expect(mockBunWrite).toHaveBeenCalledOnce();
    const [writePath] = mockBunWrite.mock.calls[0]!;
    expect(String(writePath)).toMatch(
      /threshold-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
    );
  });

  it("writes valid JSON containing a dataValues array", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));

    let capturedContent: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedContent = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    const parsed = JSON.parse(capturedContent!) as { dataValues: unknown[] };
    expect(Array.isArray(parsed.dataValues)).toBe(true);
  });

  it("fails task 4 and rethrows when Bun.write throws", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const boom = new Error("disk full");
    mockBunWrite.mockRejectedValueOnce(boom);

    const task1Handle = buildMockTaskHandle();
    const resolvePeriodsHandle = buildMockTaskHandle();
    const task2Handle = buildMockTaskHandle();
    const task3Handle = buildMockTaskHandle();
    const task4Handle = buildMockTaskHandle();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(task1Handle)
      .mockResolvedValueOnce(resolvePeriodsHandle)
      .mockResolvedValueOnce(task2Handle)
      .mockResolvedValueOnce(task3Handle)
      .mockResolvedValueOnce(task4Handle);

    const ctx = buildMockContext({
      handlerConfig: baseConfig(),
      tasks: { startTask },
    });

    await expect(thresholdGeneration.execute(ctx)).rejects.toThrow("disk full");
    expect(task4Handle.fail).toHaveBeenCalledWith(boom);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path", () => {
  it("calls all four tasks and returns filename + count", async () => {
    // 2 org units, Monthly 2023, yearsToInclude=2, method=mean+2SD
    // Historical for Jan 2023: [202201, 202101]
    // Provide data for both org units in both historical periods for month 01 and 02
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
        { dx: "DE1", pe: "202202", ou: "OU1", value: 30 },
        { dx: "DE1", pe: "202102", ou: "OU1", value: 40 },
        { dx: "DE1", pe: "202201", ou: "OU2", value: 5 },
        { dx: "DE1", pe: "202101", ou: "OU2", value: 15 },
      ])
    );

    const task1Handle = buildMockTaskHandle();
    const resolvePeriodsHandle = buildMockTaskHandle();
    const task2Handle = buildMockTaskHandle();
    const task3Handle = buildMockTaskHandle();
    const task4Handle = buildMockTaskHandle();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(task1Handle)
      .mockResolvedValueOnce(resolvePeriodsHandle)
      .mockResolvedValueOnce(task2Handle)
      .mockResolvedValueOnce(task3Handle)
      .mockResolvedValueOnce(task4Handle);

    const ctx = buildMockContext({
      handlerConfig: baseConfig(),
      tasks: { startTask },
    });

    const result = (await thresholdGeneration.execute(ctx)) as { filename: string; count: number };

    expect(task1Handle.succeed).toHaveBeenCalled();
    expect(resolvePeriodsHandle.succeed).toHaveBeenCalled();
    expect(task2Handle.succeed).toHaveBeenCalled();
    expect(task3Handle.succeed).toHaveBeenCalled();
    expect(task4Handle.succeed).toHaveBeenCalled();
    expect(result.filename).toMatch(
      /^threshold-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
    );
    // OU1 has data for 202301 and 202302; OU2 only for 202301 → 3 DataValues
    expect(result.count).toBe(3);
  });

  it("tasks are started in the correct order", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const startTask = vi.fn().mockResolvedValue(buildMockTaskHandle());
    const ctx = buildMockContext({ handlerConfig: baseConfig(), tasks: { startTask } });

    await thresholdGeneration.execute(ctx);

    const names = startTask.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual([
      "resolve-org-units",
      "resolve-periods",
      "fetch-analytics-data",
      "calculate-thresholds",
      "write-output-file",
    ]);
  });

  it("rounds threshold values to integers for DHIS2", async () => {
    // mean+2SD of [1, 2] → mean=1.5, SD=0.5, result=2.5 (clean)
    // Try [1, 3] → mean=2, SD=1, result=4 (clean)
    // Try [1, 4] → mean=2.5, SD=1.5, result=5.5 (clean)
    // Use [1, 2, 4] → mean=7/3≈2.3333, SD≈1.2472, result≈4.828
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 1 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 2 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as { dataValues: { value: string }[] };
    if (payload.dataValues.length > 0) {
      const valueStr = payload.dataValues[0]!.value;
      expect(Number.isInteger(parseFloat(valueStr))).toBe(true);
    }
  });
});

// ── WHO methods ───────────────────────────────────────────────────────────────

describe("WHO threshold methods", () => {
  it("fetches adjacent months when calculationMethod is C-SUM", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));
    const ctx = buildMockContext({
      handlerConfig: { ...baseConfig(), calculationMethod: "C-SUM", yearsToInclude: 2 },
    });
    await thresholdGeneration.execute(ctx);

    const allPe = allAnalyticsPeriodDimensions();
    expect(allPe).toMatch(/202112/);
    expect(allPe).toMatch(/202202/);
  });

  it("applies 75th percentile to same-period historical values", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
        { dx: "DE1", pe: "202001", ou: "OU1", value: 30 },
        { dx: "DE1", pe: "201901", ou: "OU1", value: 40 },
        { dx: "DE1", pe: "201801", ou: "OU1", value: 50 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        period: { years: ["2023"], periodType: "Monthly", yearsToInclude: 5 },
        calculationMethod: "75th percentile",
      },
    });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as {
      dataValues: { value: string; period: string }[];
    };
    const jan = payload.dataValues.find((dv) => dv.period === "202301");
    expect(jan).toBeDefined();
    expect(parseFloat(jan!.value)).toBe(40);
  });

  it("applies 25th percentile to same-period historical values", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
        { dx: "DE1", pe: "202001", ou: "OU1", value: 30 },
        { dx: "DE1", pe: "201901", ou: "OU1", value: 40 },
        { dx: "DE1", pe: "201801", ou: "OU1", value: 50 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        period: { years: ["2023"], periodType: "Monthly", yearsToInclude: 5 },
        calculationMethod: "25th percentile",
      },
    });
    await thresholdGeneration.execute(ctx);

    const payload = JSON.parse(capturedPayload!) as {
      dataValues: { value: string; period: string }[];
    };
    const jan = payload.dataValues.find((dv) => dv.period === "202301");
    expect(jan).toBeDefined();
    expect(parseFloat(jan!.value)).toBe(20);
  });

  it("writes multiple output data elements when outputs is configured", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { dx: "DE1", pe: "202201", ou: "OU1", value: 10 },
        { dx: "DE1", pe: "202101", ou: "OU1", value: 20 },
      ])
    );

    let capturedPayload: string | undefined;
    mockBunWrite.mockImplementation((_path: string, content: string) => {
      capturedPayload = content;
      return Promise.resolve(0);
    });

    const ctx = buildMockContext({
      handlerConfig: {
        ...baseConfig(),
        outputDataElementId: undefined,
        outputs: [
          { calculationMethod: "mean", outputDataElementId: "DE_MEAN" },
          { calculationMethod: "75th percentile", outputDataElementId: "DE_P75" },
        ],
      },
    });
    const result = (await thresholdGeneration.execute(ctx)) as { count: number };
    expect(result.count).toBe(2);

    const payload = JSON.parse(capturedPayload!) as {
      dataValues: { dataElement: string }[];
    };
    const elements = payload.dataValues.map((dv) => dv.dataElement).sort();
    expect(elements).toEqual(["DE_MEAN", "DE_P75"]);
  });
});
