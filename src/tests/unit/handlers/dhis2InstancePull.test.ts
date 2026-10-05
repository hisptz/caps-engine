import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { AxiosError, AxiosHeaders } from "axios";
import { buildMockContext } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

const mockSourceGet = vi.fn();

vi.mock("@/shared/clients/dhis.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/clients/dhis.ts")>();
  return {
    describeRouteError: actual.describeRouteError,
    dhis2RestClient: { get: vi.fn(), post: vi.fn() },
    createRouteClient: vi.fn(() => ({ get: mockSourceGet })),
  };
});

/** Saved chunks per cache folder, standing in for files under OUTPUTS_DIR. */
const savedChunks = new Map<string, Map<string, unknown>>();

vi.mock(
  "@/services/worker/services/handlers/dhis2InstancePull/utils/chunkCache.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/services/worker/services/handlers/dhis2InstancePull/utils/chunkCache.ts")
      >();
    return {
      chunkKey: actual.chunkKey,
      sweepOldChunkFolders: async () => 0,
      createChunkCache: (dir: string) => {
        const folder = () => savedChunks.get(dir) ?? savedChunks.set(dir, new Map()).get(dir)!;
        return {
          read: async (key: string) => savedChunks.get(dir)?.get(key),
          save: async (key: string, value: unknown) => {
            folder().set(key, structuredClone(value));
          },
          clear: async () => {
            savedChunks.delete(dir);
          },
        };
      },
    };
  }
);

const mockBunWrite = vi.fn().mockResolvedValue(0);
beforeEach(() => {
  stubBun({ write: mockBunWrite });
});

// ── Module imports (after mocks are declared) ─────────────────────────────────

import { createRouteClient, dhis2RestClient } from "@/shared/clients/dhis.ts";
import { dhis2InstancePull } from "@/services/worker/services/handlers/dhis2InstancePull/index.ts";
import {
  dhis2InstancePullConfigSchema,
  dhis2InstancePullContextSchema,
} from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";
import { resolvePullPeriods } from "@/services/worker/services/handlers/dhis2InstancePull/utils/periods.ts";
import { StepError } from "@/shared/utils/error.ts";

const mockStagingGet = vi.mocked(dhis2RestClient.get);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASES = "fbfJHSPpUQD"; // data element, pulled into itself
const TESTED = "x3Do5e7g4Qo"; // data element, pulled into a different staging element
const TESTED_STAGING = "tStgTested1";
const RATE = "Uvn6LCg7dVU"; // indicator
const RATE_STAGING = "tStgRate001";
const OU_A = "ImspTQPwCqd";
const OU_B = "O6uvpzGd5pu";
const OU_C = "fdc6uOvgoji";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routeCode: "caps-src-play",
    items: [
      { from: CASES, fromType: "DATA_ELEMENT" },
      { from: TESTED, fromType: "DATA_ELEMENT", into: TESTED_STAGING },
      { from: RATE, fromType: "INDICATOR", into: RATE_STAGING },
    ],
    orgUnit: { ids: [OU_A, OU_B] },
    period: { mode: "fixed", periodType: "MONTHLY", start: "202601", end: "202603" },
    ...overrides,
  };
}

/** IDs inside an `id:in:[a,b]` filter. */
function filterIds(params: unknown): string[] {
  const filter = (params as { filter: string }).filter;
  return /^id:in:\[(.*)\]$/.exec(filter)![1]!.split(",");
}

/** Field and values of an `id:in:[a,b]`, `code:in:[a,b]` or `code:eq:a` filter. */
function filterValues(params: unknown): { field: string; values: string[] } {
  const filter = (params as { filter: string }).filter;
  const [, field, op, rest] = /^(\w+):(in|eq):(.*)$/.exec(filter)!;
  return { field: field!, values: op === "eq" ? [rest!] : rest!.slice(1, -1).split(",") };
}

/** Org unit codes on staging (by ID); org units not listed have no code. */
let stagingOrgUnitCodes: Record<string, string> = {};

function dimension(params: URLSearchParams, name: string): string[] {
  const value = params.getAll("dimension").find((d) => d.startsWith(`${name}:`))!;
  return value.slice(name.length + 1).split(";");
}

type ComboFixture = {
  name: string;
  isDefault: boolean;
  categoryOptionCombos: Array<{ id: string; name: string }>;
};

const DEFAULT_COMBO: ComboFixture = {
  name: "default",
  isDefault: true,
  categoryOptionCombos: [{ id: "HllvX50cXC0", name: "default" }],
};

function combo(...optionCombos: Array<[string, string]>): ComboFixture {
  return {
    name: "Age and sex",
    isDefault: false,
    categoryOptionCombos: optionCombos.map(([id, name]) => ({ id, name })),
  };
}

type SourceOptions = {
  missingOrgUnits?: string[];
  lastAnalyticsTableSuccess?: string;
  meError?: Error;
  /** Category combos of source data elements; default combo when not listed. */
  combos?: Record<string, ComboFixture>;
  valueTypes?: Record<string, string>;
  /** Analytics answers without values, like a source with no data for the window. */
  noData?: boolean;
  /** Org units the source has under other IDs, by source ID → code. */
  orgUnitCodes?: Record<string, string>;
};

/** Source instance that has every requested item and answers 1 per (dx, pe, ou). */
function mockSource({
  missingOrgUnits = [],
  lastAnalyticsTableSuccess = "2030-01-01T00:00:00.000",
  meError,
  combos = {},
  valueTypes = {},
  noData = false,
  orgUnitCodes = {},
}: SourceOptions = {}) {
  mockSourceGet.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    switch (url) {
      case "me.json":
        if (meError) throw meError;
        return { data: { id: "sourceUser01" } };
      case "system/info.json":
        return { data: { version: "2.41.2", lastAnalyticsTableSuccess } };
      case "organisationUnits.json": {
        const { field, values } = filterValues(config?.params);
        if (field === "code") {
          const organisationUnits = Object.entries(orgUnitCodes)
            .filter(([, code]) => values.includes(code))
            .map(([id, code]) => ({ id, code }));
          return { data: { organisationUnits } };
        }
        return {
          data: {
            organisationUnits: values
              .filter((id) => !missingOrgUnits.includes(id))
              .map((id) => ({ id })),
          },
        };
      }
      case "dataElements.json":
        return {
          data: {
            dataElements: filterIds(config?.params).map((id) => ({
              id,
              categoryCombo: combos[id] ?? DEFAULT_COMBO,
              valueType: valueTypes[id],
            })),
          },
        };
      case "analytics/dataValueSet.json": {
        if (noData) return { data: {} };
        const params = config!.params as URLSearchParams;
        // `DE.COC` operands come back per option combo; plain items with analytics' own combo.
        const dataValues = dimension(params, "dx").flatMap((dx) => {
          const [dataElement, categoryOptionCombo = "sqGRzCziswD"] = dx.split(".");
          return dimension(params, "pe").flatMap((period) =>
            dimension(params, "ou").map((orgUnit) => ({
              dataElement,
              period,
              orgUnit,
              categoryOptionCombo,
              value: "1",
            }))
          );
        });
        return { data: { dataValues } };
      }
      default:
        throw new Error(`unexpected source GET ${url}`);
    }
  });
}

/**
 * Staging that has every data element and org unit except `missing`; data elements use the
 * default category combo unless listed in `combos`.
 */
function mockStaging(
  missing: string[] = [],
  combos: Record<string, ComboFixture> = {},
  valueTypes: Record<string, string> = {}
) {
  mockStagingGet.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    const resource = url.replace(/\.json$/, "");
    const ids = filterIds(config?.params).filter((id) => !missing.includes(id));
    return {
      data: {
        [resource]: ids.map((id) =>
          resource === "dataElements"
            ? { id, categoryCombo: combos[id] ?? DEFAULT_COMBO, valueType: valueTypes[id] }
            : { id, code: stagingOrgUnitCodes[id] }
        ),
      },
    };
  });
}

function analyticsCalls() {
  return mockSourceGet.mock.calls.filter(([url]) => url === "analytics/dataValueSet.json");
}

function writtenDataValues(): Array<Record<string, string>> {
  const [, content] = mockBunWrite.mock.calls[0]!;
  return (JSON.parse(content as string) as { dataValues: Array<Record<string, string>> })
    .dataValues;
}

beforeEach(() => {
  vi.clearAllMocks();
  savedChunks.clear();
  stagingOrgUnitCodes = {};
  mockBunWrite.mockResolvedValue(0);
  mockStaging();
  mockSource();
});

// ── Periods ───────────────────────────────────────────────────────────────────

describe("resolvePullPeriods", () => {
  const september = DateTime.fromISO("2026-09-15T10:00:00Z", { zone: "utc" });

  it("relative monthly window skips the current period with offset 1", () => {
    expect(
      resolvePullPeriods(
        { mode: "relative", periodType: "MONTHLY", count: 3, offset: 1 },
        september
      )
    ).toEqual(["202606", "202607", "202608"]);
  });

  it("relative window with offset 0 includes the current period", () => {
    expect(
      resolvePullPeriods(
        { mode: "relative", periodType: "MONTHLY", count: 2, offset: 0 },
        september
      )
    ).toEqual(["202608", "202609"]);
  });

  it("relative weekly window crosses the ISO year boundary", () => {
    // 2026-01-07 is in 2026W2; 2026W1 starts on 2025-12-29
    const now = DateTime.fromISO("2026-01-07T08:00:00Z", { zone: "utc" });
    expect(
      resolvePullPeriods({ mode: "relative", periodType: "WEEKLY", count: 3, offset: 1 }, now)
    ).toEqual(["2025W51", "2025W52", "2026W1"]);
  });

  it("fixed monthly range crosses years", () => {
    expect(
      resolvePullPeriods({ mode: "fixed", periodType: "MONTHLY", start: "202511", end: "202602" })
    ).toEqual(["202511", "202512", "202601", "202602"]);
  });

  it("fixed weekly range normalises zero-padded weeks", () => {
    expect(
      resolvePullPeriods({ mode: "fixed", periodType: "WEEKLY", start: "2026W05", end: "2026W07" })
    ).toEqual(["2026W5", "2026W6", "2026W7"]);
  });

  it("rejects a fixed range that ends before it starts", () => {
    expect(() =>
      resolvePullPeriods({ mode: "fixed", periodType: "MONTHLY", start: "202603", end: "202601" })
    ).toThrow(/ends \(202601\) before it starts \(202603\)/);
  });
});

// ── Config schema ─────────────────────────────────────────────────────────────

describe("dhis2InstancePullConfigSchema", () => {
  it("applies chunk and offset defaults", () => {
    const parsed = dhis2InstancePullConfigSchema.parse(
      baseConfig({ period: { mode: "relative", periodType: "WEEKLY", count: 4 } })
    );
    expect(parsed.chunk).toEqual({ periods: 12, orgUnits: 50 });
    expect(parsed.period).toMatchObject({ mode: "relative", offset: 1 });
  });

  it("requires `into` for indicators", () => {
    const result = dhis2InstancePullConfigSchema.safeParse(
      baseConfig({ items: [{ from: RATE, fromType: "INDICATOR" }] })
    );
    expect(result.success).toBe(false);
  });

  it("rejects two items writing into the same staging data element", () => {
    const result = dhis2InstancePullConfigSchema.safeParse(
      baseConfig({
        items: [
          { from: CASES, fromType: "DATA_ELEMENT" },
          { from: TESTED, fromType: "DATA_ELEMENT", into: CASES },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects route codes without the caps-src- prefix", () => {
    expect(dhis2InstancePullConfigSchema.safeParse(baseConfig({ routeCode: "caps" })).success).toBe(
      false
    );
  });

  it("rejects period IDs that don't match the period type", () => {
    const result = dhis2InstancePullConfigSchema.safeParse(
      baseConfig({
        period: { mode: "fixed", periodType: "WEEKLY", start: "202601", end: "2026W4" },
      })
    );
    expect(result.success).toBe(false);
  });
});

// ── Handler ───────────────────────────────────────────────────────────────────

describe("dhis2-instance-pull handler", () => {
  it("pulls through the configured route and rewrites source IDs to staging data elements", async () => {
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const result = (await dhis2InstancePull.execute(ctx)) as Record<string, unknown>;

    expect(createRouteClient).toHaveBeenCalledWith("caps-src-play");
    const values = writtenDataValues();
    // 3 items × 3 periods × 2 org units
    expect(values).toHaveLength(18);
    expect(new Set(values.map((v) => v.dataElement))).toEqual(
      new Set([CASES, TESTED_STAGING, RATE_STAGING])
    );
    // Totals only: category option combos are left to staging's default
    expect(values[0]).toEqual({
      dataElement: expect.any(String),
      period: expect.any(String),
      orgUnit: expect.any(String),
      value: "1",
    });
    expect(result).toMatchObject({
      routeCode: "caps-src-play",
      filename: expect.stringMatching(/^dhis2-instance-pull-.*\.json$/),
      count: 18,
      counts: { [CASES]: 6, [TESTED_STAGING]: 6, [RATE_STAGING]: 6 },
      periods: ["202601", "202602", "202603"],
      orgUnits: 2,
      skippedOrgUnits: [],
      sourceVersion: "2.41.2",
    });
  });

  it("splits the download into chunks of periods × org units", async () => {
    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: [OU_A, OU_B, OU_C] },
        chunk: { periods: 2, orgUnits: 2 },
      }),
    });
    await dhis2InstancePull.execute(ctx);

    const calls = analyticsCalls().map(([, config]) => {
      const params = (config as { params: URLSearchParams }).params;
      return [dimension(params, "pe"), dimension(params, "ou")];
    });
    expect(calls).toEqual([
      [
        ["202601", "202602"],
        [OU_A, OU_B],
      ],
      [["202601", "202602"], [OU_C]],
      [["202603"], [OU_A, OU_B]],
      [["202603"], [OU_C]],
    ]);
    expect(writtenDataValues()).toHaveLength(27);
  });

  it("checks org units on the source in large lookups, not per download chunk", async () => {
    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        orgUnit: { ids: [OU_A, OU_B, OU_C] },
        chunk: { periods: 12, orgUnits: 1 },
      }),
    });
    await dhis2InstancePull.execute(ctx);

    const lookups = mockSourceGet.mock.calls.filter(([url]) => url === "organisationUnits.json");
    expect(lookups).toHaveLength(1);
    expect(analyticsCalls()).toHaveLength(3);
  });

  it("asks analytics for unrounded values", async () => {
    await dhis2InstancePull.execute(buildMockContext({ handlerConfig: baseConfig() }));

    const [, config] = analyticsCalls()[0]!;
    expect((config as { params: URLSearchParams }).params.get("skipRounding")).toBe("true");
  });

  it("writes an empty file that dhis2-data-upload may skip when the source has no data", async () => {
    mockSource({ noData: true });
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const result = (await dhis2InstancePull.execute(ctx)) as Record<string, unknown>;

    expect(writtenDataValues()).toEqual([]);
    expect(result).toMatchObject({ count: 0, allowEmpty: true });
  });

  it("fails preflight with the list of missing staging data elements, before downloading", async () => {
    mockStaging([RATE_STAGING]);
    const ctx = buildMockContext({ handlerConfig: baseConfig() });

    const error = await dhis2InstancePull.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).details).toMatchObject({
      missingDataElements: [RATE_STAGING],
      missingOrgUnits: [],
    });
    expect(analyticsCalls()).toHaveLength(0);
    expect(mockBunWrite).not.toHaveBeenCalled();
  });

  it("skips org units the source doesn't have, with a warning", async () => {
    mockSource({ missingOrgUnits: [OU_B] });
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const result = (await dhis2InstancePull.execute(ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ orgUnits: 1, skippedOrgUnits: [OU_B], count: 9 });
    expect(writtenDataValues().every((v) => v.orgUnit === OU_A)).toBe(true);
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("don't exist on the source"),
      expect.objectContaining({ orgUnits: [OU_B] })
    );
  });

  it("warns when the source's analytics are older than the pulled periods", async () => {
    mockSource({ lastAnalyticsTableSuccess: "2026-03-15T02:00:00.000" });
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await dhis2InstancePull.execute(ctx);

    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("analytics are older"),
      expect.objectContaining({ lastPeriod: "202603" })
    );
  });

  it("explains a refused route call", async () => {
    const response = {
      status: 403,
      statusText: "Forbidden",
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    };
    mockSource({
      meError: new AxiosError("Forbidden", "ERR_BAD_REQUEST", undefined, undefined, response),
    });
    const ctx = buildMockContext({ handlerConfig: baseConfig() });

    const error = await dhis2InstancePull.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).details.description).toMatch(
      /caps-src-play.*refused the request \(HTTP 403\)/
    );
    expect(analyticsCalls()).toHaveLength(0);
  });
});

// ── Option combos ─────────────────────────────────────────────────────────────

describe("dhis2-instance-pull option combos", () => {
  const SOURCE_AGE_SEX = combo(
    ["srcU5Male01", "<5, Male"],
    ["srcU5Fema01", "<5, Female"],
    ["src5pMale01", "5+, Male"]
  );

  function oneItem(item: Record<string, unknown>) {
    return baseConfig({
      items: [item],
      orgUnit: { ids: [OU_A] },
      period: {
        mode: "fixed",
        periodType: "MONTHLY",
        start: "202601",
        end: "202601",
      },
    });
  }

  it("pulls per option combo with operands when staging has the same option combo IDs", async () => {
    mockSource({ combos: { [CASES]: SOURCE_AGE_SEX } });
    mockStaging([], { [CASES]: SOURCE_AGE_SEX });
    const ctx = buildMockContext({
      handlerConfig: oneItem({ from: CASES, fromType: "DATA_ELEMENT" }),
    });
    const result = (await dhis2InstancePull.execute(ctx)) as Record<string, unknown>;

    const [, config] = analyticsCalls()[0]!;
    expect(dimension((config as { params: URLSearchParams }).params, "dx")).toEqual([
      `${CASES}.srcU5Male01`,
      `${CASES}.srcU5Fema01`,
      `${CASES}.src5pMale01`,
    ]);
    expect(writtenDataValues().map((v) => v.categoryOptionCombo)).toEqual([
      "srcU5Male01",
      "srcU5Fema01",
      "src5pMale01",
    ]);
    expect(result).toMatchObject({ count: 3, byOptionCombo: [CASES] });
  });

  it("matches option combos by name, in any option order, when IDs differ", async () => {
    mockSource({ combos: { [CASES]: SOURCE_AGE_SEX } });
    mockStaging([], {
      [CASES]: combo(
        ["stgU5Male01", "Male, <5"],
        ["stgU5Fema01", "<5,  female"],
        ["stg5pMale01", "5+, Male"]
      ),
    });
    const ctx = buildMockContext({
      handlerConfig: oneItem({ from: CASES, fromType: "DATA_ELEMENT" }),
    });
    await dhis2InstancePull.execute(ctx);

    expect(writtenDataValues().map((v) => v.categoryOptionCombo)).toEqual([
      "stgU5Male01",
      "stgU5Fema01",
      "stg5pMale01",
    ]);
  });

  it("fails when only some option combos match, so totals can't drift", async () => {
    const partial = combo(["stgU5Male01", "<5, Male"], ["stgU5Fema01", "<5, Female"]);
    mockSource({ combos: { [CASES]: SOURCE_AGE_SEX } });
    mockStaging([], { [CASES]: partial });

    const ctx = buildMockContext({
      handlerConfig: oneItem({ from: CASES, fromType: "DATA_ELEMENT" }),
    });
    const error = await dhis2InstancePull.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).details.items).toEqual([
      expect.objectContaining({ from: CASES, unmatched: ["5+, Male"] }),
    ]);
    expect(analyticsCalls()).toHaveLength(0);
  });

  it("pulls a total when the staging data element has no categories, dropping the source combo", async () => {
    mockSource({ combos: { [CASES]: SOURCE_AGE_SEX } });
    const ctx = buildMockContext({
      handlerConfig: oneItem({ from: CASES, fromType: "DATA_ELEMENT" }),
    });
    await dhis2InstancePull.execute(ctx);

    const [, config] = analyticsCalls()[0]!;
    expect(dimension((config as { params: URLSearchParams }).params, "dx")).toEqual([CASES]);
    expect(writtenDataValues()[0]).not.toHaveProperty("categoryOptionCombo");
  });

  it("refuses totals into a staging data element that has categories", async () => {
    mockStaging([], { [RATE_STAGING]: SOURCE_AGE_SEX });
    const indicator = buildMockContext({
      handlerConfig: oneItem({ from: RATE, fromType: "INDICATOR", into: RATE_STAGING }),
    });
    const error = await dhis2InstancePull.execute(indicator).catch((e: unknown) => e);
    expect((error as StepError).details.items).toEqual([
      expect.objectContaining({ from: RATE, reason: expect.stringContaining("only give totals") }),
    ]);

    mockStaging([], { [CASES]: SOURCE_AGE_SEX });
    const noCategoriesAtSource = buildMockContext({
      handlerConfig: oneItem({ from: CASES, fromType: "DATA_ELEMENT" }),
    });
    const error2 = await dhis2InstancePull.execute(noCategoriesAtSource).catch((e: unknown) => e);
    expect((error2 as StepError).details.items).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("the source's has none") }),
    ]);
  });
});

describe("dhis2-instance-pull request size", () => {
  it("splits many option combo operands over several requests", async () => {
    const many = combo(
      ...Array.from({ length: 60 }, (_, i): [string, string] => [
        `coc${String(i).padStart(8, "0")}`,
        `Option ${i}`,
      ])
    );
    mockSource({ combos: { [CASES]: many } });
    mockStaging([], { [CASES]: many });
    const ctx = buildMockContext({
      handlerConfig: baseConfig({
        items: [{ from: CASES, fromType: "DATA_ELEMENT" }],
        orgUnit: { ids: [OU_A] },
        period: { mode: "fixed", periodType: "MONTHLY", start: "202601", end: "202601" },
      }),
    });
    await dhis2InstancePull.execute(ctx);

    const sizes = analyticsCalls().map(
      ([, config]) => dimension((config as { params: URLSearchParams }).params, "dx").length
    );
    expect(sizes).toEqual([50, 10]);
    expect(writtenDataValues()).toHaveLength(60);
  });
});

describe("dhis2-instance-pull value types", () => {
  async function problems(): Promise<unknown> {
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    const error = await dhis2InstancePull.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect(analyticsCalls()).toHaveLength(0);
    return (error as StepError).details.items;
  }

  it("refuses a staging data element that doesn't hold numbers", async () => {
    mockStaging([], {}, { [CASES]: "TEXT" });
    expect(await problems()).toEqual([
      expect.objectContaining({ from: CASES, reason: expect.stringContaining("TEXT values") }),
    ]);
  });

  it("refuses indicators into whole-number data elements", async () => {
    mockStaging([], {}, { [RATE_STAGING]: "INTEGER_ZERO_OR_POSITIVE" });
    expect(await problems()).toEqual([
      expect.objectContaining({ from: RATE, reason: expect.stringContaining("whole numbers") }),
    ]);
  });

  it("refuses a decimal source data element into a whole-number one", async () => {
    mockSource({ valueTypes: { [TESTED]: "NUMBER" } });
    mockStaging([], {}, { [TESTED_STAGING]: "INTEGER" });
    expect(await problems()).toEqual([
      expect.objectContaining({ from: TESTED, target: TESTED_STAGING }),
    ]);
  });

  it("accepts numeric targets that can hold the values", async () => {
    mockSource({ valueTypes: { [CASES]: "INTEGER", [TESTED]: "INTEGER" } });
    mockStaging(
      [],
      {},
      { [CASES]: "INTEGER", [TESTED_STAGING]: "NUMBER", [RATE_STAGING]: "PERCENTAGE" }
    );
    const ctx = buildMockContext({ handlerConfig: baseConfig() });
    await expect(dhis2InstancePull.execute(ctx)).resolves.toMatchObject({ count: 18 });
  });
});

describe("dhis2-instance-pull retries", () => {
  /** One chunk per period; the 202602 chunk fails. */
  function failFebruary() {
    const answer = mockSourceGet.getMockImplementation()!;
    mockSourceGet.mockImplementation(async (url: string, config?: { params?: unknown }) => {
      if (
        url === "analytics/dataValueSet.json" &&
        dimension(config!.params as URLSearchParams, "pe")[0] === "202602"
      ) {
        throw new Error("socket hang up");
      }
      return answer(url, config) as unknown;
    });
  }

  function requestedPeriods(): string[] {
    return analyticsCalls().map(
      ([, config]) => dimension((config as { params: URLSearchParams }).params, "pe")[0]!
    );
  }

  const config = () => baseConfig({ chunk: { periods: 1, orgUnits: 50 } });

  it("downloads only the failed chunk and the ones after it on a retry", async () => {
    failFebruary();
    const first = await dhis2InstancePull
      .execute(buildMockContext({ handlerConfig: config() }))
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(StepError);
    expect(requestedPeriods()).toEqual(["202601", "202602"]);

    mockSourceGet.mockClear();
    mockSource();
    const retry = buildMockContext({ handlerConfig: config() });
    const result = (await dhis2InstancePull.execute(retry)) as Record<string, unknown>;

    expect(requestedPeriods()).toEqual(["202602", "202603"]);
    expect(result).toMatchObject({ count: 18 });
    expect(writtenDataValues()).toHaveLength(18);
    expect(retry.tasks.startTask).toHaveBeenCalledWith(
      "download-chunk",
      expect.objectContaining({ chunk: "1/3", reused: true })
    );
    expect(retry.log).toHaveBeenCalledWith("INFO", expect.stringContaining("Reused chunks"), {
      reused: 1,
      downloaded: 2,
    });
  });

  it("deletes the saved chunks once the file is written", async () => {
    await dhis2InstancePull.execute(buildMockContext({ handlerConfig: config() }));
    expect(savedChunks.size).toBe(0);
  });

  it("doesn't reuse chunks from another execution", async () => {
    failFebruary();
    await dhis2InstancePull
      .execute(buildMockContext({ handlerConfig: config() }))
      .catch(() => undefined);

    mockSourceGet.mockClear();
    mockSource();
    const other = buildMockContext({ handlerConfig: config() });
    other.stepExecution = { ...other.stepExecution, executionId: "execution-2" };
    await dhis2InstancePull.execute(other);

    expect(requestedPeriods()).toEqual(["202601", "202602", "202603"]);
  });
});

describe("dhis2-instance-pull org unit matching by code", () => {
  const SRC_A = "srcOuA00001";
  const SRC_B = "srcOuB00001";
  const config = () => baseConfig({ orgUnitMatch: "code" });

  function requestedOrgUnits(): string[] {
    return analyticsCalls().flatMap(([, c]) =>
      dimension((c as { params: URLSearchParams }).params, "ou")
    );
  }

  it("pulls source org units with the same code and writes under the staging IDs", async () => {
    stagingOrgUnitCodes = { [OU_A]: "OU_A", [OU_B]: "OU_B" };
    mockSource({ orgUnitCodes: { [SRC_A]: "OU_A", [SRC_B]: "OU_B" } });
    const result = (await dhis2InstancePull.execute(
      buildMockContext({ handlerConfig: config() })
    )) as Record<string, unknown>;

    expect(new Set(requestedOrgUnits())).toEqual(new Set([SRC_A, SRC_B]));
    expect(new Set(writtenDataValues().map((v) => v.orgUnit))).toEqual(new Set([OU_A, OU_B]));
    expect(result).toMatchObject({ count: 18, orgUnits: 2, skippedOrgUnits: [] });
  });

  it("skips org units without a code or with a code the source doesn't have", async () => {
    stagingOrgUnitCodes = { [OU_A]: "OU_A", [OU_B]: "OU_B" };
    mockSource({ orgUnitCodes: { [SRC_A]: "OU_A" } });
    const ctx = buildMockContext({
      handlerConfig: baseConfig({ orgUnitMatch: "code", orgUnit: { ids: [OU_A, OU_B, OU_C] } }),
    });
    const result = (await dhis2InstancePull.execute(ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ orgUnits: 1, skippedOrgUnits: [OU_B, OU_C] });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("no matching code"),
      expect.objectContaining({ count: 2, withoutCode: 1 })
    );
  });

  it("fails when no org unit matches by code", async () => {
    mockSource({ orgUnitCodes: { [SRC_A]: "OU_A" } });
    const error = await dhis2InstancePull
      .execute(buildMockContext({ handlerConfig: config() }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/matching code/);
    expect((error as StepError).details).toMatchObject({ withoutCode: [OU_A, OU_B] });
    expect(analyticsCalls()).toHaveLength(0);
  });

  it("looks up codes with commas one at a time", async () => {
    stagingOrgUnitCodes = { [OU_A]: "OU_A", [OU_B]: "Clinic, North" };
    mockSource({ orgUnitCodes: { [SRC_A]: "OU_A", [SRC_B]: "Clinic, North" } });
    await dhis2InstancePull.execute(buildMockContext({ handlerConfig: config() }));

    const filters = mockSourceGet.mock.calls
      .filter(([url]) => url === "organisationUnits.json")
      .map(([, c]) => (c as { params: { filter: string } }).params.filter);
    expect(filters).toEqual(["code:in:[OU_A]", "code:eq:Clinic, North"]);
    expect(new Set(requestedOrgUnits())).toEqual(new Set([SRC_A, SRC_B]));
  });

  it("splits long codes over several lookups to keep URLs short", async () => {
    const longCode = (n: number) => `${"x".repeat(1990)}${n}`;
    stagingOrgUnitCodes = { [OU_A]: longCode(1), [OU_B]: longCode(2), [OU_C]: longCode(3) };
    mockSource({ orgUnitCodes: { [SRC_A]: longCode(1), [SRC_B]: longCode(2) } });
    await dhis2InstancePull.execute(
      buildMockContext({
        handlerConfig: baseConfig({ orgUnitMatch: "code", orgUnit: { ids: [OU_A, OU_B, OU_C] } }),
      })
    );

    const lookups = mockSourceGet.mock.calls.filter(([url]) => url === "organisationUnits.json");
    expect(
      lookups.map(([, c]) => filterValues((c as { params: unknown }).params).values.length)
    ).toEqual([2, 1]);
  });

  it("defaults to matching by ID", () => {
    expect(dhis2InstancePullConfigSchema.parse(baseConfig()).orgUnitMatch).toBe("id");
  });
});

describe("dhis2InstancePullContextSchema", () => {
  it("accepts a context without a period, so the step's own period is used", () => {
    expect(dhis2InstancePullContextSchema.safeParse({}).success).toBe(true);
  });
});
