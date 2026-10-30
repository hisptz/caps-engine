// ============================================================
// Rules — a small, closed subset of JSONLogic (https://jsonlogic.com)
// Stored as plain JSON on pipeline connectors; evaluated without eval().
//
//   { ">": [{ "var": "context.step_2_output.count" }, 0] }
//
// Supported operators: var, ==, !=, >, >=, <, <=, and, or, !, !!, in.
// Anything else is rejected when the rule is saved.
// ============================================================

export type Rule = unknown;

const COMPARISON_OPERATORS = ["==", "!=", ">", ">=", "<", "<="] as const;
const SUPPORTED_OPERATORS = new Set<string>([
  "var",
  ...COMPARISON_OPERATORS,
  "and",
  "or",
  "!",
  "!!",
  "in",
]);

/** Deep rules are almost certainly a mistake; a cap keeps evaluation cheap. */
const MAX_RULE_DEPTH = 20;

function isOperation(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1
  );
}

/** Resolve a dot path ("step_1_output.orgUnits.0") against a value. Missing segments give undefined. */
export function resolvePath(source: unknown, path: string): unknown {
  if (path === "") return source;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Explains why a rule is not valid, or returns null when it is. */
export function validateRule(rule: Rule, depth = 0): string | null {
  if (depth > MAX_RULE_DEPTH) {
    return `Rule is nested deeper than ${MAX_RULE_DEPTH} levels`;
  }
  if (rule === null || ["string", "number", "boolean"].includes(typeof rule)) {
    return null;
  }
  if (Array.isArray(rule)) {
    for (const item of rule) {
      const error = validateRule(item, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (!isOperation(rule)) {
    return "Each rule object must have exactly one operator key";
  }

  const [operator, args] = Object.entries(rule)[0]!;
  if (!SUPPORTED_OPERATORS.has(operator)) {
    return `Unsupported rule operator "${operator}"`;
  }
  if (operator === "var") {
    const path: unknown = Array.isArray(args) ? (args as unknown[])[0] : args;
    if (typeof path !== "string") {
      return `"var" takes a dot path string`;
    }
    return null;
  }
  const list = Array.isArray(args) ? args : [args];
  if ((COMPARISON_OPERATORS as readonly string[]).includes(operator) || operator === "in") {
    if (list.length !== 2) {
      return `"${operator}" takes exactly two arguments`;
    }
  }
  return validateRule(list, depth + 1);
}

/** JSONLogic truthiness: like JavaScript, except an empty array is false. */
export function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === "object" || typeof b === "object") {
    return a === b;
  }
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return a === b;
}

function compare(operator: (typeof COMPARISON_OPERATORS)[number], a: unknown, b: unknown): boolean {
  if (operator === "==") return looseEquals(a, b);
  if (operator === "!=") return !looseEquals(a, b);
  // Ordering a missing value is never true: "count > 0" is false when count is absent
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const left = typeof a === "number" || typeof b === "number" ? Number(a) : a;
  const right = typeof a === "number" || typeof b === "number" ? Number(b) : b;
  if (typeof left === "number" && (Number.isNaN(left) || Number.isNaN(right as number))) {
    return false;
  }
  switch (operator) {
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
  }
}

/** Evaluate a rule against data. Assumes the rule passed validateRule. */
export function evaluateRule(rule: Rule, data: unknown): unknown {
  if (Array.isArray(rule)) {
    return rule.map((item) => evaluateRule(item, data));
  }
  if (!isOperation(rule)) {
    return rule;
  }

  const [operator, args] = Object.entries(rule)[0]!;

  if (operator === "var") {
    const [path, fallback] = (Array.isArray(args) ? args : [args]) as [unknown, unknown?];
    const value = resolvePath(data, path as string);
    return value === undefined ? (fallback ?? null) : value;
  }

  const list = Array.isArray(args) ? args : [args];

  switch (operator) {
    case "and": {
      let last: unknown = true;
      for (const item of list) {
        last = evaluateRule(item, data);
        if (!isTruthy(last)) return last;
      }
      return last;
    }
    case "or": {
      let last: unknown = false;
      for (const item of list) {
        last = evaluateRule(item, data);
        if (isTruthy(last)) return last;
      }
      return last;
    }
    case "!":
      return !isTruthy(evaluateRule(list[0], data));
    case "!!":
      return isTruthy(evaluateRule(list[0], data));
    case "in": {
      const needle = evaluateRule(list[0], data);
      const haystack = evaluateRule(list[1], data);
      if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle));
      if (typeof haystack === "string") return haystack.includes(String(needle));
      return false;
    }
    default:
      return compare(
        operator as (typeof COMPARISON_OPERATORS)[number],
        evaluateRule(list[0], data),
        evaluateRule(list[1], data)
      );
  }
}

/** A null or missing rule always passes. */
export function ruleMatches(rule: Rule, data: unknown): boolean {
  if (rule === null || rule === undefined) return true;
  return isTruthy(evaluateRule(rule, data));
}
