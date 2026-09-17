import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn(), post: vi.fn() },
}));

const mockBunWrite = vi.fn().mockResolvedValue(0);
beforeEach(() => {
  stubBun({ write: mockBunWrite });
});

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { alertGeneration } from "@/services/worker/services/handlers/alertGeneration/index.ts";
import {
  ALERT_ACTUAL_VALUE_DE_CODE,
  ALERT_PROGRAM_CODE,
  ALERT_PROGRAM_STAGE_CODE,
  ALERT_REPORTING_PERIOD_DE_CODE,
  ALERT_THRESHOLD_VALUE_DE_CODE,
} from "@/services/worker/services/handlers/alertGeneration/constants.ts";
import { parseAlertGenerationConfig } from "@/services/worker/services/handlers/alertGeneration/schemas/config.ts";
import { createFixedPeriodFromPeriodId } from "@dhis2/multi-calendar-dates";

// Display name is formatted with the runtime's Intl data ("January 2023" on Bun, "2023 January" on Node)
const JAN_2023_DISPLAY_NAME = createFixedPeriodFromPeriodId({
  periodId: "202301",
  calendar: "iso8601",
})?.displayName;

const mockGet = vi.mocked(dhis2RestClient.get);

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgUnit: { ids: ["OU1", "OU2"] },
    period: { periods: ["202301", "202302"] },
    thresholdDataElementId: "DE_THRESHOLD",
    valueDataElementIds: ["DE_VALUE"],
    ...overrides,
  };
}

function analyticsResponse(rows: { ou: string; pe: string; dx: string; value: number }[]) {
  return {
    data: {
      headers: [{ name: "dx" }, { name: "pe" }, { name: "ou" }, { name: "value" }],
      rows: rows.map((r) => [r.dx, r.pe, r.ou, String(r.value)]),
    },
  };
}

function analyticsGetCalls() {
  return mockGet.mock.calls.filter((c) => String(c[0]) === "/analytics");
}

function analyticsPeriodDimension(params: URLSearchParams): string {
  const dimension = params.getAll("dimension").find((d) => d.startsWith("pe:"));
  if (!dimension) throw new Error("expected pe dimension in analytics params");
  return dimension;
}

function analyticsDataElementDimension(params: URLSearchParams): string {
  const dimension = params.getAll("dimension").find((d) => d.startsWith("dx:"));
  if (!dimension) throw new Error("expected dx dimension in analytics params");
  return dimension;
}

function writtenPayload(): { events: unknown[] } {
  const call = mockBunWrite.mock.calls[0];
  if (!call?.[1]) throw new Error("expected Bun.write to be called");
  return JSON.parse(String(call[1])) as { events: unknown[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(analyticsResponse([]));
  mockBunWrite.mockResolvedValue(0);
});

describe("alert-generation", () => {
  it("throws when orgUnit selectors are missing", async () => {
    const ctx = buildMockContext({ handlerConfig: { ...baseConfig(), orgUnit: {} } });
    await expect(alertGeneration.execute(ctx)).rejects.toThrow(
      /orgUnit: at least one of ids, levels, or groups/
    );
  });

  it("uses configured period IDs verbatim in analytics query", async () => {
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await alertGeneration.execute(ctx);

    expect(analyticsGetCalls().length).toBeGreaterThan(0);
    const params = (analyticsGetCalls()[0]![1] as { params: URLSearchParams }).params;
    expect(analyticsPeriodDimension(params)).toBe("pe:202301;202302");
  });

  it("requests deduped threshold and quantile data elements in analytics", async () => {
    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        valueDataElementIds: ["DE_Q1", "DE_Q1", "DE_Q2"],
      }),
    });
    await alertGeneration.execute(ctx);

    const params = (analyticsGetCalls()[0]![1] as { params: URLSearchParams }).params;
    const dx = analyticsDataElementDimension(params);
    expect(dx).toBe("dx:DE_THRESHOLD;DE_Q1;DE_Q2");
  });

  it("parses legacy valueDataElementId into valueDataElementIds", async () => {
    const parsed = parseAlertGenerationConfig({
      orgUnit: { ids: ["OU1"] },
      period: { periods: ["202301"] },
      thresholdDataElementId: "DE_THRESHOLD",
      valueDataElementId: "DE_LEGACY",
    });
    expect(parsed.valueDataElementIds).toEqual(["DE_LEGACY"]);
    expect(parsed).not.toHaveProperty("valueDataElementId");

    const deduped = parseAlertGenerationConfig({
      orgUnit: { ids: ["OU1"] },
      period: { periods: ["202301"] },
      thresholdDataElementId: "DE_THRESHOLD",
      valueDataElementIds: ["DE_A", "DE_A", "DE_B"],
    });
    expect(deduped.valueDataElementIds).toEqual(["DE_A", "DE_B"]);
  });

  it("creates events when value >= threshold (single quantile parity)", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 10 },
        { ou: "OU1", pe: "202301", dx: "DE_VALUE", value: 15 },
        { ou: "OU1", pe: "202302", dx: "DE_THRESHOLD", value: 20 },
        { ou: "OU1", pe: "202302", dx: "DE_VALUE", value: 20 },
        { ou: "OU2", pe: "202301", dx: "DE_THRESHOLD", value: 5 },
        { ou: "OU2", pe: "202301", dx: "DE_VALUE", value: 3 },
      ])
    );

    const ctx = buildMockContext({
      handlerConfig: baseConfig({ orgUnit: { ids: ["OU1", "OU2"] } }),
    });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 2 });
    const payload = writtenPayload();
    expect(payload.events).toHaveLength(2);

    const janEvent = payload.events[0] as {
      program: string;
      programStage: string;
      orgUnit: string;
      occurredAt: string;
      status: string;
      dataValues: { dataElement: string; value: string }[];
    };
    expect(janEvent.program).toBe(ALERT_PROGRAM_CODE);
    expect(janEvent.programStage).toBe(ALERT_PROGRAM_STAGE_CODE);
    expect(janEvent.orgUnit).toBe("OU1");
    expect(janEvent.occurredAt).toBe("2023-01-01T00:00:00.000");
    expect(janEvent.status).toBe("COMPLETED");
    expect(janEvent.dataValues).toEqual([
      { dataElement: ALERT_THRESHOLD_VALUE_DE_CODE, value: "10" },
      { dataElement: ALERT_ACTUAL_VALUE_DE_CODE, value: "15" },
      { dataElement: ALERT_REPORTING_PERIOD_DE_CODE, value: JAN_2023_DISPLAY_NAME },
    ]);
  });

  it("creates one event when any of two quantiles meets threshold (OR)", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 10 },
        { ou: "OU1", pe: "202301", dx: "DE_Q_LOW", value: 5 },
        { ou: "OU1", pe: "202301", dx: "DE_Q_HIGH", value: 12 },
      ])
    );

    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: ["OU1"] },
        valueDataElementIds: ["DE_Q_LOW", "DE_Q_HIGH"],
      }),
    });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 1 });
    const payload = writtenPayload();
    expect(payload.events).toHaveLength(1);
    const event = payload.events[0] as { dataValues: { dataElement: string; value: string }[] };
    expect(event.dataValues).toEqual([
      { dataElement: ALERT_THRESHOLD_VALUE_DE_CODE, value: "10" },
      { dataElement: ALERT_ACTUAL_VALUE_DE_CODE, value: "12" },
      { dataElement: ALERT_REPORTING_PERIOD_DE_CODE, value: JAN_2023_DISPLAY_NAME },
    ]);
  });

  it("skips when all quantiles are below threshold", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 20 },
        { ou: "OU1", pe: "202301", dx: "DE_Q1", value: 10 },
        { ou: "OU1", pe: "202301", dx: "DE_Q2", value: 15 },
      ])
    );

    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: ["OU1"] },
        valueDataElementIds: ["DE_Q1", "DE_Q2"],
      }),
    });
    const result = await alertGeneration.execute(ctx);

    expect(result).toEqual({ count: 0 });
    expect(mockBunWrite).not.toHaveBeenCalled();
  });

  it("skips when value < threshold", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 20 },
        { ou: "OU1", pe: "202301", dx: "DE_VALUE", value: 10 },
      ])
    );

    const ctx = buildMockContext({ handlerConfig: baseConfig({ orgUnit: { ids: ["OU1"] } }) });
    const result = await alertGeneration.execute(ctx);

    expect(result).toEqual({ count: 0 });
    expect(mockBunWrite).not.toHaveBeenCalled();
  });

  it("alerts using available quantiles when one configured quantile row is missing", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 10 },
        { ou: "OU1", pe: "202301", dx: "DE_Q_PRESENT", value: 11 },
      ])
    );

    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: ["OU1"] },
        valueDataElementIds: ["DE_Q_PRESENT", "DE_Q_MISSING"],
      }),
    });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 1 });
    expect(ctx.log).toHaveBeenCalledWith(
      "INFO",
      "Comparing partial quantile set for org unit/period",
      expect.objectContaining({ presentQuantileCount: 1, configuredQuantileCount: 2 })
    );
  });

  it("mirrors CHAP five-quantile mapping with threshold between q25 and q50", async () => {
    const quantileDes = {
      q10: "DE_Q10",
      q25: "DE_Q25",
      q50: "DE_Q50",
      q75: "DE_Q75",
      q90: "DE_Q90",
    };

    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 30 },
        { ou: "OU1", pe: "202301", dx: quantileDes.q10, value: 10 },
        { ou: "OU1", pe: "202301", dx: quantileDes.q25, value: 25 },
        { ou: "OU1", pe: "202301", dx: quantileDes.q50, value: 50 },
        { ou: "OU1", pe: "202301", dx: quantileDes.q75, value: 75 },
        { ou: "OU1", pe: "202301", dx: quantileDes.q90, value: 90 },
      ])
    );

    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: ["OU1"] },
        valueDataElementIds: Object.values(quantileDes),
      }),
    });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 1 });
    const event = writtenPayload().events[0] as {
      dataValues: { dataElement: string; value: string }[];
    };
    expect(event.dataValues).toEqual([
      { dataElement: ALERT_THRESHOLD_VALUE_DE_CODE, value: "30" },
      { dataElement: ALERT_ACTUAL_VALUE_DE_CODE, value: "90" },
      { dataElement: ALERT_REPORTING_PERIOD_DE_CODE, value: JAN_2023_DISPLAY_NAME },
    ]);
  });

  it("does not write output file when no events are generated", async () => {
    mockGet.mockResolvedValue(analyticsResponse([]));

    const ctx = buildMockContext({ handlerConfig: baseConfig({ orgUnit: { ids: ["OU1"] } }) });
    const result = await alertGeneration.execute(ctx);

    expect(result).toEqual({ count: 0 });
    expect(result).not.toHaveProperty("filename");
    expect(mockBunWrite).not.toHaveBeenCalled();
  });

  it("skips and warns when threshold is missing", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([{ ou: "OU1", pe: "202301", dx: "DE_VALUE", value: 10 }])
    );

    const ctx = buildMockContext({ handlerConfig: baseConfig({ orgUnit: { ids: ["OU1"] } }) });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 0 });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      "Skipping org unit/period due to missing threshold",
      expect.objectContaining({ orgUnit: "OU1", periodId: "202301" })
    );
  });

  it("skips and warns when no quantile values are present", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([{ ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 10 }])
    );

    const ctx = buildMockContext({ handlerConfig: baseConfig({ orgUnit: { ids: ["OU1"] } }) });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 0 });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      "Skipping org unit/period due to missing quantile values",
      expect.objectContaining({ orgUnit: "OU1", periodId: "202301" })
    );
  });

  it("returns filename and count", async () => {
    mockGet.mockResolvedValue(
      analyticsResponse([
        { ou: "OU1", pe: "202301", dx: "DE_THRESHOLD", value: 1 },
        { ou: "OU1", pe: "202301", dx: "DE_VALUE", value: 2 },
      ])
    );

    const ctx = buildMockContext({ handlerConfig: baseConfig({ orgUnit: { ids: ["OU1"] } }) });
    const result = await alertGeneration.execute(ctx);

    expect(result).toMatchObject({ count: 1 });
    expect(result).toHaveProperty("filename");
    expect(String((result as { filename: string }).filename)).toMatch(/^alert-.*\.json$/);
  });
});
