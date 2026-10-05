import { pullItemTarget, type PullItem } from "../schemas/config.ts";
import { matchCategoryOptionCombos, type ComboMeta } from "./categoryCombos.ts";
import { valueTypeProblem } from "./valueTypes.ts";

export type ItemPlan =
  | { from: string; target: string; mode: "total" }
  | {
      from: string;
      target: string;
      mode: "combos";
      /** Source option combo ID → staging option combo ID. */
      stagingComboBySource: Map<string, string>;
    };

export type ItemProblem = {
  from: string;
  target: string;
  reason: string;
  unmatched?: string[];
};

/**
 * Decides, per item, whether to pull a total or one value per option combo, from the category
 * combos of the source data element and the staging data element it writes into. Items whose
 * values the staging data element can't store (see `valueTypeProblem`) are problems.
 * - staging data element without categories → the total (indicators and program indicators
 *   always end up here);
 * - staging data element with categories → per option combo, matched by ID then by name;
 *   every source option combo must match, or the staging total would silently differ from
 *   the source's.
 * `staging` and `source` map data element IDs to their category combos; a target missing from
 * `staging` is reported in `missingTargets`.
 */
export function planItems(
  items: PullItem[],
  staging: ReadonlyMap<string, ComboMeta>,
  source: ReadonlyMap<string, ComboMeta>
): { plans: ItemPlan[]; problems: ItemProblem[]; missingTargets: string[] } {
  const plans: ItemPlan[] = [];
  const problems: ItemProblem[] = [];
  const missingTargets: string[] = [];

  for (const item of items) {
    const target = pullItemTarget(item);
    const stagingCombo = staging.get(target);
    if (!stagingCombo) {
      missingTargets.push(target);
      continue;
    }
    const typeProblem = valueTypeProblem(
      item.fromType,
      source.get(item.from)?.valueType,
      stagingCombo.valueType
    );
    if (typeProblem) {
      problems.push({ from: item.from, target, reason: typeProblem });
      continue;
    }
    if (stagingCombo.isDefault) {
      plans.push({ from: item.from, target, mode: "total" });
      continue;
    }
    if (item.fromType !== "DATA_ELEMENT") {
      problems.push({
        from: item.from,
        target,
        reason:
          "The staging data element has categories, but indicators and program indicators only give totals. Pick a staging data element without categories.",
      });
      continue;
    }
    const sourceCombo = source.get(item.from);
    if (!sourceCombo) {
      problems.push({
        from: item.from,
        target,
        reason: "The source instance has no data element with this ID.",
      });
      continue;
    }
    const match = matchCategoryOptionCombos(sourceCombo, stagingCombo);
    if (match.kind === "total") {
      plans.push({ from: item.from, target, mode: "total" });
      continue;
    }
    if (match.kind === "incompatible") {
      problems.push({
        from: item.from,
        target,
        reason:
          match.reason === "source-has-no-categories"
            ? "The staging data element has categories but the source's has none, so there's no breakdown to fill it. Pick a staging data element without categories."
            : "None of the source's option combos match the staging data element's, by ID or by name.",
      });
      continue;
    }
    const unmatched = match.unmatched.map((c) => c.name || c.id);
    if (unmatched.length > 0) {
      problems.push({
        from: item.from,
        target,
        reason:
          "Some of the source's option combos have no match on staging, so staging's total would differ from the source's.",
        unmatched,
      });
      continue;
    }
    plans.push({
      from: item.from,
      target,
      mode: "combos",
      stagingComboBySource: new Map(match.pairs.map((p) => [p.sourceId, p.stagingId])),
    });
  }

  return { plans, problems, missingTargets };
}

export function dxItems(plans: ItemPlan[]): string[] {
  return plans.flatMap((plan) =>
    plan.mode === "total"
      ? [plan.from]
      : [...plan.stagingComboBySource.keys()].map((coc) => `${plan.from}.${coc}`)
  );
}
