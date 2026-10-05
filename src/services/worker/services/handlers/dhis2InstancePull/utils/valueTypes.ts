import type { PullItem } from "../schemas/config.ts";

const INTEGER_TYPES = new Set([
  "INTEGER",
  "INTEGER_POSITIVE",
  "INTEGER_NEGATIVE",
  "INTEGER_ZERO_OR_POSITIVE",
]);
const DECIMAL_TYPES = new Set(["NUMBER", "PERCENTAGE", "UNIT_INTERVAL"]);

/**
 * Why values of this item can't be stored in a staging data element of `stagingValueType`,
 * or null when they can (or the value type is unknown, leaving it to the import):
 * - the staging data element must be numeric;
 * - whole-number staging data elements can't take indicator values or a decimal source
 *   data element's values, which DHIS2 would reject as conflicts on import.
 */
export function valueTypeProblem(
  fromType: PullItem["fromType"],
  sourceValueType: string | undefined,
  stagingValueType: string | undefined
): string | null {
  if (!stagingValueType) {
    return null;
  }
  if (!INTEGER_TYPES.has(stagingValueType) && !DECIMAL_TYPES.has(stagingValueType)) {
    return `The staging data element holds ${stagingValueType} values, not numbers. Pick a numeric data element.`;
  }
  if (!INTEGER_TYPES.has(stagingValueType)) {
    return null;
  }
  if (fromType === "INDICATOR") {
    return "Indicator values can have decimals, but the staging data element only takes whole numbers. Pick one with value type Number.";
  }
  if (fromType === "DATA_ELEMENT" && sourceValueType && DECIMAL_TYPES.has(sourceValueType)) {
    return "The source data element has decimal values, but the staging one only takes whole numbers. Pick one with value type Number.";
  }
  return null;
}
