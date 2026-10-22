import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

type PostedPayload = { dataValues: Array<Record<string, string>> };

const mockTargetGet = vi.fn();
const mockTargetPost = vi.fn<(url: string, payload: PostedPayload, options: unknown) => unknown>();

vi.mock("@/shared/clients/dhis.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/clients/dhis.ts")>();
  return {
    describeRouteError: actual.describeRouteError,
    dhis2RestClient: { get: vi.fn(), post: vi.fn() },
    createRouteClient: vi.fn(() => ({ get: mockTargetGet, post: mockTargetPost })),
  };
});

// ── Module imports (after mocks are declared) ─────────────────────────────────

import { createRouteClient, dhis2RestClient } from "@/shared/clients/dhis.ts";
import { dhis2InstancePush } from "@/services/worker/services/handlers/dhis2InstancePush/index.ts";
import { StepSkippedError } from "@/services/worker/types/service.ts";
import { StepError } from "@/shared/utils/error.ts";

const mockStagingGet = vi.mocked(dhis2RestClient.get);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASES = "fbfJHSPpUQD";
const RISK = "x3Do5e7g4Qo";
const RISK_TARGET = "tgtRisk0001";
const OU_A = "ImspTQPwCqd";
const OU_B = "O6uvpzGd5pu";

const DEFAULT_COMBO = {
  name: "default",
  isDefault: true,
  categoryOptionCombos: [{ id: "HllvX50cXC0", name: "default" }],
};

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routeCode: "caps-src-hmis",
    items: [{ from: CASES }, { from: RISK, into: RISK_TARGET }],
    orgUnit: { ids: [OU_A, OU_B] },
    period: { mode: "updated", days: 7 },
    ...overrides,
  };
}

function dataElementRows(ids: string[]) {
  return ids.map((id) => ({
    id,
    valueType: "NUMBER",
    aggregationType: "SUM",
    categoryCombo: DEFAULT_COMBO,
  }));
}

function idsIn(params: unknown): string[] {
  const filter = (params as { filter: string }).filter;
  return /^\w+:in:\[(.*)\]$/.exec(filter)![1]!.split(",");
}

type TargetOptions = {
  dataElements?: string[];
  orgUnits?: Array<{ id: string; code?: string; closedDate?: string }>;
};

function mockTarget({
  dataElements = [CASES, RISK_TARGET],
  orgUnits = [{ id: OU_A }, { id: OU_B }],
}: TargetOptions = {}) {
  mockTargetGet.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    switch (url) {
      case "me.json":
        return { data: { id: "me" } };
      case "system/info.json":
        return { data: { version: "2.41.3" } };
      case "dataElements.json": {
        const wanted = idsIn(config?.params);
        return {
          data: { dataElements: dataElementRows(dataElements.filter((id) => wanted.includes(id))) },
        };
      }
      case "organisationUnits.json": {
        const filter = (config?.params as { filter: string }).filter;
        const field = filter.startsWith("code") ? "code" : "id";
        const wanted = idsIn(config?.params);
        return {
          data: {
            organisationUnits: orgUnits.filter((unit) => wanted.includes(unit[field] ?? "")),
          },
        };
      }
      default:
        throw new Error(`Unexpected target GET ${url}`);
    }
  });
  mockTargetPost.mockResolvedValue({
    data: {
      status: "OK",
      response: {
        responseType: "ImportSummary",
        status: "SUCCESS",
        importCount: { imported: 2, updated: 0, ignored: 0, deleted: 0 },
        conflicts: [],
      },
    },
  });
}

const STAGING_VALUES = [
  { dataElement: CASES, period: "202601", orgUnit: OU_A, value: "10" },
  { dataElement: RISK, period: "202601", orgUnit: OU_B, value: 0.5 },
];

/** Staging reads: data element metadata, org units (with codes) and data values. */
let stagingValues: Array<Record<string, unknown>> = STAGING_VALUES;
const valueReads: URLSearchParams[] = [];
const analyticsReads: URLSearchParams[] = [];

function mockStaging(codes: Record<string, string> = {}) {
  mockStagingGet.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === "system/info.json") {
      return { data: { lastAnalyticsTableSuccess: "2026-10-20T02:00:00.000" } };
    }
    if (url === "analytics/dataValueSet.json") {
      const params = config!.params as URLSearchParams;
      analyticsReads.push(params);
      const ou = params
        .getAll("dimension")
        .find((d) => d.startsWith("ou:"))!
        .slice(3)
        .split(";");
      return {
        data: { dataValues: stagingValues.filter((v) => ou.includes(v.orgUnit as string)) },
      };
    }
    if (url === "dataValueSets.json") {
      const params = config!.params as URLSearchParams;
      valueReads.push(params);
      const orgUnits = params.getAll("orgUnit");
      return {
        data: { dataValues: stagingValues.filter((v) => orgUnits.includes(v.orgUnit as string)) },
      };
    }
    const wanted = idsIn(config?.params);
    if (url === "dataElements.json") {
      return {
        data: { dataElements: dataElementRows([CASES, RISK].filter((id) => wanted.includes(id))) },
      };
    }
    if (url === "organisationUnits.json") {
      return {
        data: {
          organisationUnits: wanted.map((id) => ({
            id,
            ...(codes[id] ? { code: codes[id] } : {}),
          })),
        },
      };
    }
    throw new Error(`Unexpected staging GET ${url}`);
  });
}

function context(config: Record<string, unknown> = baseConfig()) {
  return buildMockContext({ handlerConfig: config });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dhis2-instance-push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valueReads.length = 0;
    analyticsReads.length = 0;
    stagingValues = STAGING_VALUES;
    mockTarget();
    mockStaging();
  });

  it("reads recently updated staging values and sends them mapped, through the route", async () => {
    const result = await dhis2InstancePush.execute(context());

    const [read] = valueReads;
    expect(read!.getAll("dataElement")).toEqual([CASES, RISK]);
    expect(read!.getAll("orgUnit")).toEqual([OU_A, OU_B]);
    expect(read!.get("lastUpdatedDuration")).toBe("7d");
    expect(read!.has("period")).toBe(false);

    expect(createRouteClient).toHaveBeenCalledWith("caps-src-hmis");
    const [url, payload, options] = mockTargetPost.mock.calls[0]!;
    expect(url).toBe("/dataValueSets");
    expect(payload).toEqual({
      dataValues: [
        { dataElement: CASES, period: "202601", orgUnit: OU_A, value: "10" },
        { dataElement: RISK_TARGET, period: "202601", orgUnit: OU_B, value: "0.5" },
      ],
    });
    expect(options).toEqual({ params: { importStrategy: "CREATE_AND_UPDATE" } });
    expect(result).toMatchObject({
      status: "SUCCESS",
      read: 2,
      sent: 2,
      imported: 2,
      targetVersion: "2.41.3",
    });
  });

  it("reads a fixed range of periods", async () => {
    await dhis2InstancePush.execute(
      context(
        baseConfig({
          period: { mode: "fixed", periodType: "MONTHLY", start: "202601", end: "202603" },
        })
      )
    );
    expect(valueReads[0]!.getAll("period")).toEqual(["202601", "202602", "202603"]);
    expect(valueReads[0]!.has("lastUpdatedDuration")).toBe(false);
  });

  it("reads analytics totals for a range of periods when the source is analytics", async () => {
    const result = await dhis2InstancePush.execute(
      context(
        baseConfig({
          source: "analytics",
          period: { mode: "fixed", periodType: "MONTHLY", start: "202601", end: "202602" },
        })
      )
    );
    expect(valueReads).toHaveLength(0);
    expect(analyticsReads[0]!.getAll("dimension")).toEqual([
      `dx:${CASES};${RISK}`,
      "pe:202601;202602",
      `ou:${OU_A};${OU_B}`,
    ]);
    expect(analyticsReads[0]!.get("skipRounding")).toBe("true");
    expect(result).toMatchObject({ source: "analytics", sent: 2 });
  });

  it("rejects reading analytics by last update", async () => {
    await expect(
      dhis2InstancePush.execute(context(baseConfig({ source: "analytics" })))
    ).rejects.toThrow(/Analytics can't be read by last update/);
  });

  it("reads staging in chunks of org units", async () => {
    await dhis2InstancePush.execute(context(baseConfig({ chunk: { orgUnits: 1 } })));
    expect(valueReads.map((params) => params.getAll("orgUnit"))).toEqual([[OU_A], [OU_B]]);
  });

  it("passes the import strategy to the target", async () => {
    await dhis2InstancePush.execute(context(baseConfig({ importStrategy: "UPDATE" })));
    expect(mockTargetPost.mock.calls[0]![2]).toEqual({ params: { importStrategy: "UPDATE" } });
  });

  it("sends values in chunks", async () => {
    stagingValues = Array.from({ length: 250 }, (_, i) => ({
      dataElement: CASES,
      period: `2026${String((i % 12) + 1).padStart(2, "0")}`,
      orgUnit: i % 2 ? OU_A : OU_B,
      value: String(i),
    }));
    await dhis2InstancePush.execute(context(baseConfig({ chunk: { values: 100 } })));
    expect(mockTargetPost.mock.calls.map(([, payload]) => payload.dataValues.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it("matches org units by code and reads only the matched ones", async () => {
    mockStaging({ [OU_A]: "OU_A_CODE" });
    mockTarget({ orgUnits: [{ id: "targetOuA01", code: "OU_A_CODE" }] });
    const result = await dhis2InstancePush.execute(context(baseConfig({ orgUnitMatch: "code" })));
    expect(valueReads[0]!.getAll("orgUnit")).toEqual([OU_A]);
    expect(mockTargetPost.mock.calls[0]![1].dataValues).toEqual([
      { dataElement: CASES, period: "202601", orgUnit: "targetOuA01", value: "10" },
    ]);
    expect(result).toMatchObject({ skippedOrgUnits: [OU_B] });
  });

  it("leaves out values for org units closed on the target", async () => {
    mockTarget({ orgUnits: [{ id: OU_A, closedDate: "2025-12-31T00:00:00.000" }, { id: OU_B }] });
    const result = await dhis2InstancePush.execute(context());
    expect(mockTargetPost.mock.calls[0]![1].dataValues).toHaveLength(1);
    expect(result).toMatchObject({ closedValues: 1, sent: 1 });
  });

  it("fails when a target data element is missing, before reading or sending anything", async () => {
    mockTarget({ dataElements: [CASES] });
    const error = (await dhis2InstancePush
      .execute(context())
      .catch((e: unknown) => e)) as StepError;
    expect(error).toBeInstanceOf(StepError);
    expect(error.details).toMatchObject({ missingOnTarget: [RISK_TARGET] });
    expect(valueReads).toHaveLength(0);
    expect(mockTargetPost).not.toHaveBeenCalled();
  });

  it("fails when none of the selected org units exist on the target", async () => {
    mockTarget({ orgUnits: [] });
    await expect(dhis2InstancePush.execute(context())).rejects.toThrow(
      /None of the selected org units exist/
    );
  });

  it("is skipped when staging has no values to push", async () => {
    stagingValues = [];
    await expect(dhis2InstancePush.execute(context())).rejects.toThrow(StepSkippedError);
    expect(mockTargetPost).not.toHaveBeenCalled();
  });

  it("fails the step when the target rejects a chunk", async () => {
    mockTargetPost.mockResolvedValue({
      data: {
        status: "ERROR",
        response: {
          responseType: "ImportSummary",
          status: "ERROR",
          description: "Import failed",
          conflicts: [{ object: CASES, value: "Data element not assigned to a data set" }],
        },
      },
    });
    const error = (await dhis2InstancePush
      .execute(context())
      .catch((e: unknown) => e)) as StepError;
    expect(error).toBeInstanceOf(StepError);
    expect(error.details).toMatchObject({ source: "dhis2-target", totalConflicts: 1 });
  });

  it("rejects a config without org units or period", async () => {
    await expect(
      dhis2InstancePush.execute(context(baseConfig({ orgUnit: {}, period: undefined })))
    ).rejects.toThrow(/Invalid dhis2-instance-push handlerConfig/);
  });
});
