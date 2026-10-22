import { describe, it, expect } from "vitest";
import {
  analyticsDxItems,
  mapPushValues,
  planPushItems,
  type PushMeta,
} from "@/services/worker/services/handlers/dhis2InstancePush/utils/itemPlans.ts";

const DEFAULT: PushMeta = {
  isDefault: true,
  optionCombos: [{ id: "HllvX50cXC0", name: "default" }],
  valueType: "NUMBER",
  aggregationType: "SUM",
};

function combos(pairs: Array<[string, string]>, extra: Partial<PushMeta> = {}): PushMeta {
  return {
    isDefault: false,
    optionCombos: pairs.map(([id, name]) => ({ id, name })),
    valueType: "NUMBER",
    aggregationType: "SUM",
    ...extra,
  };
}

const CASES = "fbfJHSPpUQD";
const CASES_TARGET = "tgtCases001";

describe("planPushItems", () => {
  it("sends values as they are when neither side has categories", () => {
    const { plans } = planPushItems(
      [{ from: CASES }],
      new Map([[CASES, DEFAULT]]),
      new Map([[CASES, DEFAULT]])
    );
    expect(plans).toEqual([{ from: CASES, target: CASES, mode: "total" }]);
  });

  it("sums into a target without categories when the staging element aggregates by SUM", () => {
    const { plans, problems } = planPushItems(
      [{ from: CASES, into: CASES_TARGET }],
      new Map([[CASES, combos([["cocMale0001", "Male"]])]]),
      new Map([[CASES_TARGET, DEFAULT]])
    );
    expect(problems).toEqual([]);
    expect(plans).toEqual([{ from: CASES, target: CASES_TARGET, mode: "sum" }]);
  });

  it("refuses to sum values that don't add up", () => {
    const { plans, problems } = planPushItems(
      [{ from: CASES }],
      new Map([[CASES, combos([["cocMale0001", "Male"]], { aggregationType: "AVERAGE" })]]),
      new Map([[CASES, DEFAULT]])
    );
    expect(plans).toEqual([]);
    expect(problems[0]!.reason).toMatch(/AVERAGE/);
  });

  it("reads the analytics total instead of summing, whatever the aggregation type", () => {
    const { plans, problems } = planPushItems(
      [{ from: CASES }],
      new Map([[CASES, combos([["cocMale0001", "Male"]], { aggregationType: "AVERAGE" })]]),
      new Map([[CASES, DEFAULT]]),
      "analytics"
    );
    expect(problems).toEqual([]);
    expect(plans).toEqual([{ from: CASES, target: CASES, mode: "total" }]);
  });

  it("can't split a total into a target with categories", () => {
    const { problems } = planPushItems(
      [{ from: CASES }],
      new Map([[CASES, DEFAULT]]),
      new Map([[CASES, combos([["tgtMale0001", "Male"]])]])
    );
    expect(problems[0]!.reason).toMatch(/no breakdown/);
  });

  it("pairs option combos by name and lists the unmatched ones", () => {
    const { plans } = planPushItems(
      [{ from: CASES, into: CASES_TARGET }],
      new Map([
        [
          CASES,
          combos([
            ["stgMaleU5aa", "Male, <5"],
            ["stgFemU5aaa", "Female, <5"],
            ["stgOther001", "Other, <5"],
          ]),
        ],
      ]),
      new Map([
        [
          CASES_TARGET,
          combos([
            ["tgtMaleU5aa", "<5, male"],
            ["tgtFemU5aaa", "<5, Female"],
          ]),
        ],
      ])
    );
    expect(plans).toEqual([
      {
        from: CASES,
        target: CASES_TARGET,
        mode: "combos",
        targetComboByStaging: new Map([
          ["stgMaleU5aa", "tgtMaleU5aa"],
          ["stgFemU5aaa", "tgtFemU5aaa"],
        ]),
        unmatched: ["Other, <5"],
      },
    ]);
  });

  it("reports data elements missing on either side", () => {
    const result = planPushItems([{ from: CASES, into: CASES_TARGET }], new Map(), new Map());
    expect(result.missingStaging).toEqual([CASES]);
    expect(result.missingTargets).toEqual([CASES_TARGET]);
  });

  it("refuses decimals into a whole-number target", () => {
    const { problems } = planPushItems(
      [{ from: CASES }],
      new Map([[CASES, DEFAULT]]),
      new Map([[CASES, { ...DEFAULT, valueType: "INTEGER" }]])
    );
    expect(problems[0]!.reason).toMatch(/whole numbers/);
  });
});

describe("mapPushValues", () => {
  const orgUnits = new Map([
    ["stagingOu01", "targetOu001"],
    ["stagingOu02", "targetOu002"],
  ]);
  const open = () => true;

  it("sums option combo values per period and org unit", () => {
    const { dataValues } = mapPushValues(
      [
        {
          dataElement: CASES,
          period: "202601",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "a",
          value: "0.1",
        },
        {
          dataElement: CASES,
          period: "202601",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "b",
          value: "0.2",
        },
        {
          dataElement: CASES,
          period: "202602",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "a",
          value: "4",
        },
      ],
      [{ from: CASES, target: CASES_TARGET, mode: "sum" }],
      orgUnits,
      open
    );
    expect(dataValues).toEqual([
      { dataElement: CASES_TARGET, period: "202601", orgUnit: "targetOu001", value: "0.3" },
      { dataElement: CASES_TARGET, period: "202602", orgUnit: "targetOu001", value: "4" },
    ]);
  });

  it("maps option combos and counts the unmatched ones", () => {
    const result = mapPushValues(
      [
        {
          dataElement: CASES,
          period: "202601",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "stgMale",
          value: "3",
        },
        {
          dataElement: CASES,
          period: "202601",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "stgOther",
          value: "1",
        },
        { dataElement: CASES, period: "202601", orgUnit: "stagingOu01", value: "9" },
      ],
      [
        {
          from: CASES,
          target: CASES_TARGET,
          mode: "combos",
          targetComboByStaging: new Map([["stgMale", "tgtMale"]]),
          unmatched: ["Other"],
        },
      ],
      orgUnits,
      open
    );
    expect(result.dataValues).toEqual([
      {
        dataElement: CASES_TARGET,
        period: "202601",
        orgUnit: "targetOu001",
        categoryOptionCombo: "tgtMale",
        value: "3",
      },
    ]);
    expect(result.unmatchedCombos).toEqual({ [CASES]: 2 });
  });

  it("drops the option combos of totals, and values of unmatched or closed org units", () => {
    const result = mapPushValues(
      [
        {
          dataElement: CASES,
          period: "202601",
          orgUnit: "stagingOu01",
          categoryOptionCombo: "HllvX50cXC0",
          attributeOptionCombo: "HllvX50cXC0",
          value: "5",
        },
        { dataElement: CASES, period: "202601", orgUnit: "stagingOu02", value: "6" },
        { dataElement: CASES, period: "202601", orgUnit: "stagingOu99", value: "7" },
      ],
      [{ from: CASES, target: CASES, mode: "total" }],
      orgUnits,
      (orgUnit) => orgUnit !== "targetOu002"
    );
    expect(result.dataValues).toEqual([
      { dataElement: CASES, period: "202601", orgUnit: "targetOu001", value: "5" },
    ]);
    expect(result.closedValues).toBe(1);
    expect(result.unmatchedOrgUnitValues).toBe(1);
  });

  it("leaves out values that can't be summed", () => {
    const result = mapPushValues(
      [
        { dataElement: CASES, period: "202601", orgUnit: "stagingOu01", value: "abc" },
        { dataElement: CASES, period: "202601", orgUnit: "stagingOu01", value: "2" },
      ],
      [{ from: CASES, target: CASES, mode: "sum" }],
      orgUnits,
      open
    );
    expect(result.notNumeric).toBe(1);
    expect(result.dataValues).toEqual([
      { dataElement: CASES, period: "202601", orgUnit: "targetOu001", value: "2" },
    ]);
  });
});

describe("analyticsDxItems", () => {
  it("asks for totals and option combo operands", () => {
    expect(
      analyticsDxItems([
        { from: CASES, target: CASES, mode: "total" },
        {
          from: "riskDe00001",
          target: "riskDe00001",
          mode: "combos",
          targetComboByStaging: new Map([
            ["cocA", "tgtA"],
            ["cocB", "tgtB"],
          ]),
          unmatched: [],
        },
      ])
    ).toEqual([CASES, "riskDe00001.cocA", "riskDe00001.cocB"]);
  });
});
