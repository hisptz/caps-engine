import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn() },
}));
vi.mock("@/services/worker/utils/orgUnitSelection.ts", () => ({
  resolveOrgUnitsWithTask: vi.fn(),
}));

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import {
  completenessPercent,
  dhis2DataCheck,
  type Dhis2DataCheckOutput,
} from "@/services/worker/services/handlers/dhis2DataCheck/index.ts";
import { dhis2DataCheckConfigSchema } from "@/services/worker/services/handlers/dhis2DataCheck/schemas/config.ts";

const mockGet = vi.mocked(dhis2RestClient.get);
const mockOrgUnits = vi.mocked(resolveOrgUnitsWithTask);

const CASES = "fbfJHSPpUQD";
const DEATHS = "cYeuwXTCPkU";

function config(overrides: Record<string, unknown> = {}) {
  return {
    dataElements: [CASES, DEATHS],
    orgUnit: { levels: [3] },
    period: { mode: "fixed", periodType: "MONTHLY", start: "202609", end: "202610" },
    ...overrides,
  };
}

function value(dataElement: string, orgUnit: string, period: string, coc = "HllvX50cXC0") {
  return { dataElement, orgUnit, period, categoryOptionCombo: coc, value: "1" };
}

describe("dhis2-data-check handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgUnits.mockResolvedValue(["ouA", "ouB"]);
  });

  it("counts each data element, org unit and period with a value once", async () => {
    mockGet.mockResolvedValue({
      data: {
        dataValues: [
          value(CASES, "ouA", "202609"),
          // Another category option of the same combination counts once
          value(CASES, "ouA", "202609", "otherCoc000"),
          value(CASES, "ouB", "202609"),
          value(DEATHS, "ouA", "202610"),
          // Not asked for: ignored
          value(CASES, "ouZ", "202609"),
        ],
      },
    });

    const result = (await dhis2DataCheck.execute(
      buildMockContext({ handlerConfig: config() })
    )) as Dhis2DataCheckOutput;

    // 2 data elements × 2 org units × 2 periods
    expect(result).toEqual({
      found: 3,
      expected: 8,
      completeness: 37.5,
      periods: ["202609", "202610"],
      orgUnitCount: 2,
    });
    const url = mockGet.mock.calls[0]![0];
    expect(url).toMatch(/^\/dataValueSets\?/);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.getAll("dataElement")).toEqual([CASES, DEATHS]);
    expect(params.getAll("orgUnit")).toEqual(["ouA", "ouB"]);
    expect(params.getAll("period")).toEqual(["202609", "202610"]);
  });

  it("reports 0, not an error, when there is no data yet", async () => {
    mockGet.mockResolvedValue({ data: {} });

    const result = (await dhis2DataCheck.execute(
      buildMockContext({ handlerConfig: config() })
    )) as Dhis2DataCheckOutput;

    expect(result).toMatchObject({ found: 0, expected: 8, completeness: 0 });
  });

  it("asks DHIS2 a chunk of org units at a time", async () => {
    mockOrgUnits.mockResolvedValue(["ou1", "ou2", "ou3"]);
    mockGet.mockResolvedValue({ data: { dataValues: [] } });

    await dhis2DataCheck.execute(buildMockContext({ handlerConfig: config({ chunkOrgUnits: 2 }) }));

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("fails the step when DHIS2 cannot be read", async () => {
    mockGet.mockRejectedValue(new Error("Request failed with status code 409"));

    await expect(
      dhis2DataCheck.execute(buildMockContext({ handlerConfig: config() }))
    ).rejects.toThrow("409");
  });

  it("rejects settings without data elements", async () => {
    await expect(
      dhis2DataCheck.execute(buildMockContext({ handlerConfig: config({ dataElements: [] }) }))
    ).rejects.toThrow("Invalid dhis2-data-check handlerConfig");
  });
});

describe("dhis2DataCheckConfigSchema", () => {
  it("defaults the chunk size and accepts a relative period", () => {
    expect(
      dhis2DataCheckConfigSchema.parse(
        config({ period: { mode: "relative", periodType: "MONTHLY", count: 1 } })
      )
    ).toMatchObject({ chunkOrgUnits: 50, period: { offset: 1 } });
  });
});

describe("completenessPercent", () => {
  it("rounds to one decimal and is 0 when nothing is expected", () => {
    expect(completenessPercent(1, 3)).toBe(33.3);
    expect(completenessPercent(0, 0)).toBe(0);
  });
});
