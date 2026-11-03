import { describe, expect, it } from "vitest";
import {
  findMappingProblems,
  findStepsLosingMappings,
  findTakenStagingDataElements,
  suggestOrgUnitMatch,
  type InstanceMapping,
} from "@/shared/mappings/instanceMappings.ts";

const MW = "caps-src-malawi";
const TZ = "caps-src-tanzania";
const CASES = "CasesAAAAAA";
const DEATHS = "DeathsAAAAA";
const RATE = "RateAAAAAAA";
const STAGING_CASES = "StgCasesAAA";
const STAGING_DEATHS = "StgDeathsAA";

const mapping = (over: Partial<InstanceMapping> = {}): InstanceMapping => ({
  remoteItem: CASES,
  remoteItemType: "DATA_ELEMENT",
  stagingDataElement: STAGING_CASES,
  direction: "PULL",
  ...over,
});

const row = (over: Partial<InstanceMapping & { routeCode: string }> = {}) => ({
  routeCode: MW,
  ...mapping(),
  ...over,
});

describe("findMappingProblems", () => {
  it("reports a remote item or staging data element paired twice", () => {
    expect(findMappingProblems([mapping(), mapping()])).toHaveLength(2);
  });

  it("refuses pushing into something that isn't a data element", () => {
    expect(
      findMappingProblems([
        mapping({ remoteItem: RATE, remoteItemType: "INDICATOR", direction: "PUSH" }),
      ])
    ).toEqual([`${RATE} can't receive pushed values: it isn't a data element`]);
    expect(findMappingProblems([mapping({ remoteItemType: "INDICATOR" })])).toEqual([]);
  });
});

describe("findTakenStagingDataElements", () => {
  const otherPulls = [row({ routeCode: TZ, remoteItem: DEATHS })];

  it("flags pulling into a staging data element another instance pulls into", () => {
    expect(findTakenStagingDataElements(MW, [mapping()], otherPulls)).toEqual([
      { stagingDataElement: STAGING_CASES, routeCode: TZ, remoteItem: DEATHS },
    ]);
  });

  it("lets several instances receive the same staging data element", () => {
    expect(findTakenStagingDataElements(MW, [mapping({ direction: "PUSH" })], otherPulls)).toEqual(
      []
    );
    expect(
      findTakenStagingDataElements(MW, [mapping()], [row({ routeCode: TZ, direction: "PUSH" })])
    ).toEqual([]);
  });
});

describe("findStepsLosingMappings", () => {
  it("lists steps whose data elements are gone or no longer go their way", () => {
    const steps = [
      {
        stepId: "a",
        stepName: "A",
        pipelineName: "P",
        direction: "PULL" as const,
        mapped: [STAGING_CASES],
      },
      {
        stepId: "b",
        stepName: "B",
        pipelineName: "P",
        direction: "PUSH" as const,
        mapped: [STAGING_CASES, STAGING_DEATHS],
      },
    ];
    expect(findStepsLosingMappings(steps, [mapping({ direction: "PULL" })])).toEqual([
      { ...steps[1], missing: [STAGING_CASES, STAGING_DEATHS] },
    ]);
  });
});

describe("suggestOrgUnitMatch", () => {
  it("goes with what most steps use, ID on a tie", () => {
    expect(suggestOrgUnitMatch(["code", "code", "id"])).toBe("code");
    expect(suggestOrgUnitMatch(["code", "id"])).toBe("id");
    expect(suggestOrgUnitMatch([])).toBe("id");
  });
});
