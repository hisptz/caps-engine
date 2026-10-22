import type { DataValue } from "@/services/worker/types/data.ts";
import {
  matchCategoryOptionCombos,
  type ComboMeta,
} from "@/services/worker/services/handlers/dhis2InstancePull/utils/categoryCombos.ts";
import { pushItemTarget, type PushItem, type PushSource } from "../schemas/config.ts";

/** A data element's category combo, value type and aggregation type, as the push needs them. */
export type PushMeta = ComboMeta & { aggregationType?: string };

export type PushPlan =
  /** Neither data element has categories: values go as they are. */
  | { from: string; target: string; mode: "total" }
  /** Staging has categories, the target has none: values are summed per period and org unit. */
  | { from: string; target: string; mode: "sum" }
  /** Both have categories: each staging option combo goes into its match on the target. */
  | {
      from: string;
      target: string;
      mode: "combos";
      targetComboByStaging: Map<string, string>;
      /** Staging option combos (names) with no match on the target; their values are left out. */
      unmatched: string[];
    };

export type PushProblem = { from: string; target: string; reason: string };

const INTEGER_TYPES = new Set([
  "INTEGER",
  "INTEGER_POSITIVE",
  "INTEGER_NEGATIVE",
  "INTEGER_ZERO_OR_POSITIVE",
]);
const NUMERIC_TYPES = new Set([...INTEGER_TYPES, "NUMBER", "PERCENTAGE", "UNIT_INTERVAL"]);

/**
 * Why staging values of `stagingType` can't be stored in a target data element of
 * `targetType`, or null when they can (or a type is unknown, leaving it to the import).
 */
function valueTypeProblem(
  stagingType: string | undefined,
  targetType: string | undefined
): string | null {
  if (!stagingType || !targetType || stagingType === targetType) {
    return null;
  }
  if (!NUMERIC_TYPES.has(stagingType) || !NUMERIC_TYPES.has(targetType)) {
    return `The staging data element holds ${stagingType} values, but the target's holds ${targetType}. Pick a target data element with the same value type.`;
  }
  if (INTEGER_TYPES.has(targetType) && !INTEGER_TYPES.has(stagingType)) {
    return "The staging data element has decimal values, but the target's only takes whole numbers. Pick one with value type Number.";
  }
  return null;
}

/**
 * Decides, per item, how its values reach the target data element, from the category combos
 * of the staging and target data elements (pull's `matchCategoryOptionCombos`, with staging as
 * the source):
 * - target without categories, staging without → as they are ("total");
 * - target without categories, staging with → summed per period and org unit ("sum"), only
 *   when the staging data element's aggregation type is SUM, as other types don't add up;
 *   reading analytics, its total ("total"), which analytics aggregates by the right type;
 * - target with categories, staging with → per option combo, matched by ID then name
 *   ("combos"); unmatched staging option combos are listed and their values left out;
 * - target with categories, staging without → a problem: a total can't be split.
 * Items missing on either side are reported in `missingStaging` / `missingTargets`.
 */
export function planPushItems(
  items: PushItem[],
  staging: ReadonlyMap<string, PushMeta>,
  target: ReadonlyMap<string, PushMeta>,
  source: PushSource = "raw"
): {
  plans: PushPlan[];
  problems: PushProblem[];
  missingStaging: string[];
  missingTargets: string[];
} {
  const plans: PushPlan[] = [];
  const problems: PushProblem[] = [];
  const missingStaging: string[] = [];
  const missingTargets: string[] = [];

  for (const item of items) {
    const targetId = pushItemTarget(item);
    const stagingMeta = staging.get(item.from);
    const targetMeta = target.get(targetId);
    if (!stagingMeta) missingStaging.push(item.from);
    if (!targetMeta) missingTargets.push(targetId);
    if (!stagingMeta || !targetMeta) continue;

    const problem = (reason: string) =>
      problems.push({ from: item.from, target: targetId, reason });
    const typeProblem = valueTypeProblem(stagingMeta.valueType, targetMeta.valueType);
    if (typeProblem) {
      problem(typeProblem);
      continue;
    }

    const match = matchCategoryOptionCombos(stagingMeta, targetMeta);
    if (match.kind === "total") {
      // Analytics gives totals itself, with the data element's own aggregation type.
      if (stagingMeta.isDefault || source === "analytics") {
        plans.push({ from: item.from, target: targetId, mode: "total" });
      } else if (stagingMeta.aggregationType === "SUM") {
        plans.push({ from: item.from, target: targetId, mode: "sum" });
      } else {
        problem(
          `The staging data element has categories but the target's has none, and its values can't be added up into a total (aggregation type ${stagingMeta.aggregationType ?? "unknown"}). Pick a target data element with the same categories.`
        );
      }
      continue;
    }
    if (match.kind === "incompatible") {
      problem(
        match.reason === "source-has-no-categories"
          ? "The target data element has categories but the staging one has none, so there's no breakdown to fill it. Pick a target data element without categories."
          : "None of the staging option combos match the target data element's, by ID or by name."
      );
      continue;
    }
    plans.push({
      from: item.from,
      target: targetId,
      mode: "combos",
      targetComboByStaging: new Map(match.pairs.map((p) => [p.sourceId, p.stagingId])),
      unmatched: match.unmatched.map((c) => c.name || c.id),
    });
  }

  return { plans, problems, missingStaging, missingTargets };
}

export type MappedValues = {
  dataValues: DataValue[];
  /** Values left out: their staging option combo has no match on the target, per staging data element. */
  unmatchedCombos: Record<string, number>;
  /** Values left out: their org unit has no match on the target. */
  unmatchedOrgUnitValues: number;
  /** Values left out: their target org unit is closed (or not yet open) for the period. */
  closedValues: number;
  /** Values left out: not a number, so they couldn't be summed. */
  notNumeric: number;
};

/** Sums of decimals like 0.1 + 0.2 would otherwise carry float noise into DHIS2. */
function formatSum(sum: number): string {
  return String(Number(sum.toPrecision(15)));
}

/**
 * Rewrites staging values for the target: data element, org unit and option combo, dropping
 * the attribute option combo (the target's default). Values of data elements without a plan
 * are expected to be filtered out already.
 */
export function mapPushValues(
  values: DataValue[],
  plans: PushPlan[],
  targetOrgUnitByStaging: ReadonlyMap<string, string>,
  isOpen: (targetOrgUnit: string, period: string) => boolean
): MappedValues {
  const planByFrom = new Map(plans.map((plan) => [plan.from, plan]));
  const dataValues: DataValue[] = [];
  const sums = new Map<string, DataValue & { sum: number }>();
  const unmatchedCombos: Record<string, number> = {};
  let unmatchedOrgUnitValues = 0;
  let closedValues = 0;
  let notNumeric = 0;

  for (const value of values) {
    const plan = planByFrom.get(value.dataElement);
    if (!plan) continue;
    const orgUnit = targetOrgUnitByStaging.get(value.orgUnit);
    if (!orgUnit) {
      unmatchedOrgUnitValues += 1;
      continue;
    }
    if (!isOpen(orgUnit, value.period)) {
      closedValues += 1;
      continue;
    }
    const base = { dataElement: plan.target, period: value.period, orgUnit };

    if (plan.mode === "total") {
      dataValues.push({ ...base, value: value.value });
    } else if (plan.mode === "combos") {
      const combo = value.categoryOptionCombo
        ? plan.targetComboByStaging.get(value.categoryOptionCombo)
        : undefined;
      if (!combo) {
        unmatchedCombos[plan.from] = (unmatchedCombos[plan.from] ?? 0) + 1;
        continue;
      }
      dataValues.push({ ...base, categoryOptionCombo: combo, value: value.value });
    } else {
      const number = Number(value.value);
      if (value.value.trim() === "" || !Number.isFinite(number)) {
        notNumeric += 1;
        continue;
      }
      const key = `${base.dataElement}|${base.period}|${base.orgUnit}`;
      const entry = sums.get(key);
      if (entry) {
        entry.sum += number;
      } else {
        sums.set(key, { ...base, value: "", sum: number });
      }
    }
  }

  for (const { sum, ...value } of sums.values()) {
    dataValues.push({ ...value, value: formatSum(sum) });
  }

  return { dataValues, unmatchedCombos, unmatchedOrgUnitValues, closedValues, notNumeric };
}

/** Analytics `dx` items for the plans: data elements for totals, `DE.COC` operands per option combo. */
export function analyticsDxItems(plans: PushPlan[]): string[] {
  return plans.flatMap((plan) =>
    plan.mode === "combos"
      ? [...plan.targetComboByStaging.keys()].map((coc) => `${plan.from}.${coc}`)
      : [plan.from]
  );
}
