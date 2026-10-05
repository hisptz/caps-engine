/** A data element's category combo (and value type) as the pull needs it. */
export type ComboMeta = {
  isDefault: boolean;
  optionCombos: { id: string; name: string }[];
  valueType?: string;
};

export type ComboPair = {
  sourceId: string;
  sourceName: string;
  stagingId: string;
  stagingName: string;
};

export type ComboMatch =
  | { kind: "total" }
  | { kind: "combos"; pairs: ComboPair[]; unmatched: { id: string; name: string }[] }
  /** Staging has categories but no source option combo can go into them. */
  | { kind: "incompatible"; reason: "source-has-no-categories" | "no-common-option-combos" };

type DataElementWithCombo = {
  id: string;
  valueType?: string;
  categoryCombo?: {
    name?: string;
    isDefault?: boolean;
    categoryOptionCombos?: { id: string; name?: string }[];
  };
};

export const COMBO_FIELDS =
  "id,valueType,categoryCombo[name,isDefault,categoryOptionCombos[id,name]]";

export function toComboMeta(dataElement: DataElementWithCombo): ComboMeta {
  const combo = dataElement.categoryCombo;
  return {
    isDefault: combo?.isDefault ?? (!combo || combo.name === "default"),
    optionCombos: (combo?.categoryOptionCombos ?? []).map(({ id, name }) => ({
      id,
      name: name ?? "",
    })),
    valueType: dataElement.valueType,
  };
}

/**
 * Option combo names are their options joined by ", " in category order ("<5, Male").
 * Comparing the options as a set, ignoring case and spacing, matches the same breakdown
 * built separately on two instances even when the categories are ordered differently.
 */
export function normalizeComboName(name: string): string {
  return name
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("|");
}

export function matchCategoryOptionCombos(source: ComboMeta, staging: ComboMeta): ComboMatch {
  if (staging.isDefault) {
    return { kind: "total" };
  }
  if (source.isDefault) {
    return { kind: "incompatible", reason: "source-has-no-categories" };
  }

  const stagingById = new Map(staging.optionCombos.map((c) => [c.id, c]));
  const stagingByName = new Map(
    staging.optionCombos.map((c) => [normalizeComboName(c.name), c] as const)
  );
  const used = new Set<string>();
  const pairs: ComboPair[] = [];
  const unmatched: { id: string; name: string }[] = [];

  for (const combo of source.optionCombos) {
    const byId = stagingById.get(combo.id);
    const match =
      byId && !used.has(byId.id) ? byId : stagingByName.get(normalizeComboName(combo.name));
    if (match && !used.has(match.id)) {
      used.add(match.id);
      pairs.push({
        sourceId: combo.id,
        sourceName: combo.name,
        stagingId: match.id,
        stagingName: match.name,
      });
    } else {
      unmatched.push(combo);
    }
  }

  if (pairs.length === 0) {
    return { kind: "incompatible", reason: "no-common-option-combos" };
  }
  return { kind: "combos", pairs, unmatched };
}
