import { describe, it, expect } from "vitest";
import {
  matchCategoryOptionCombos,
  normalizeComboName,
  toComboMeta,
} from "@/services/worker/services/handlers/dhis2InstancePull/utils/categoryCombos.ts";

const combos = (...list: Array<[string, string]>) => ({
  isDefault: false,
  optionCombos: list.map(([id, name]) => ({ id, name })),
});

describe("normalizeComboName", () => {
  it("ignores option order, case and spacing", () => {
    expect(normalizeComboName("Male, <5")).toBe(normalizeComboName("<5,  male"));
    expect(normalizeComboName("Fixed")).not.toBe(normalizeComboName("Outreach"));
  });
});

describe("toComboMeta", () => {
  it("treats a missing combo or one named default as default", () => {
    expect(toComboMeta({ id: "a" }).isDefault).toBe(true);
    expect(toComboMeta({ id: "a", categoryCombo: { name: "default" } }).isDefault).toBe(true);
    expect(
      toComboMeta({ id: "a", categoryCombo: { name: "Age", isDefault: false } }).isDefault
    ).toBe(false);
  });
});

describe("matchCategoryOptionCombos", () => {
  const source = combos(["s1", "<5, Male"], ["s2", "<5, Female"], ["s3", "5+, Male"]);

  it("is a total when staging has no categories", () => {
    expect(matchCategoryOptionCombos(source, { isDefault: true, optionCombos: [] })).toEqual({
      kind: "total",
    });
  });

  it("prefers ID matches, then names, and uses each staging combo once", () => {
    const staging = combos(["s1", "<5, Male"], ["t2", "Female, <5"], ["t3", "<5, Male"]);
    const match = matchCategoryOptionCombos(source, staging);
    expect(match).toEqual({
      kind: "combos",
      pairs: [
        { sourceId: "s1", sourceName: "<5, Male", stagingId: "s1", stagingName: "<5, Male" },
        { sourceId: "s2", sourceName: "<5, Female", stagingId: "t2", stagingName: "Female, <5" },
      ],
      unmatched: [{ id: "s3", name: "5+, Male" }],
    });
  });

  it("is incompatible when nothing matches or the source has no categories", () => {
    expect(matchCategoryOptionCombos(source, combos(["x", "0-14"])).kind).toBe("incompatible");
    expect(matchCategoryOptionCombos({ isDefault: true, optionCombos: [] }, source)).toEqual({
      kind: "incompatible",
      reason: "source-has-no-categories",
    });
  });
});
