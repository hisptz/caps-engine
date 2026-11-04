import { describe, expect, it } from "vitest";
import {
  evaluateRule,
  isTruthy,
  resolvePath,
  ruleMatches,
  validateRule,
} from "@/shared/pipeline/rules.ts";

const data = {
  status: "COMPLETED",
  context: {
    step_0_output: { count: 3, orgUnits: ["ou1", "ou2"], level: "action" },
    step_1_output: { count: 0 },
  },
};

describe("resolvePath", () => {
  it("walks objects and array indexes", () => {
    expect(resolvePath(data, "context.step_0_output.orgUnits.1")).toBe("ou2");
  });

  it("returns undefined for missing segments", () => {
    expect(resolvePath(data, "context.step_9_output.count")).toBeUndefined();
    expect(resolvePath(data, "context.step_0_output.count.deeper")).toBeUndefined();
  });

  it("returns the whole value for an empty path", () => {
    expect(resolvePath(data, "")).toBe(data);
  });
});

describe("validateRule", () => {
  it("accepts supported operators and literals", () => {
    expect(validateRule({ ">": [{ var: "context.step_0_output.count" }, 0] })).toBeNull();
    expect(
      validateRule({
        and: [{ "==": [{ var: "status" }, "COMPLETED"] }, { in: ["ou1", { var: "x" }] }],
      })
    ).toBeNull();
    expect(validateRule(true)).toBeNull();
  });

  it("rejects unknown operators", () => {
    expect(validateRule({ eval: ["1"] })).toMatch(/Unsupported rule operator "eval"/);
  });

  it("rejects objects with more than one key", () => {
    expect(validateRule({ ">": [1, 0], "<": [0, 1] })).toMatch(/exactly one operator/);
  });

  it("rejects comparisons without two arguments", () => {
    expect(validateRule({ ">": [1] })).toMatch(/exactly two arguments/);
  });

  it("rejects var without a path string", () => {
    expect(validateRule({ var: 3 })).toMatch(/dot path/);
  });

  it("rejects rules nested too deeply", () => {
    let rule: unknown = true;
    for (let i = 0; i < 30; i++) rule = { "!": [rule] };
    expect(validateRule(rule)).toMatch(/nested deeper/);
  });
});

describe("evaluateRule", () => {
  it("compares numbers", () => {
    expect(evaluateRule({ ">": [{ var: "context.step_0_output.count" }, 0] }, data)).toBe(true);
    expect(evaluateRule({ ">": [{ var: "context.step_1_output.count" }, 0] }, data)).toBe(false);
    expect(evaluateRule({ "<=": [{ var: "context.step_0_output.count" }, 3] }, data)).toBe(true);
  });

  it("treats a numeric string as a number when compared with a number", () => {
    expect(evaluateRule({ "==": ["3", 3] }, data)).toBe(true);
    expect(evaluateRule({ ">": ["10", 9] }, data)).toBe(true);
  });

  it("never orders a missing value", () => {
    expect(evaluateRule({ ">": [{ var: "context.missing" }, 0] }, data)).toBe(false);
    expect(evaluateRule({ "<": [{ var: "context.missing" }, 0] }, data)).toBe(false);
  });

  it("treats missing as equal to null", () => {
    expect(evaluateRule({ "==": [{ var: "context.missing" }, null] }, data)).toBe(true);
    expect(evaluateRule({ "!=": [{ var: "status" }, null] }, data)).toBe(true);
  });

  it("uses the var default when the path is missing", () => {
    expect(evaluateRule({ var: ["context.missing", 7] }, data)).toBe(7);
  });

  it("short-circuits and / or", () => {
    expect(
      evaluateRule(
        { and: [{ "==": [{ var: "status" }, "COMPLETED"] }, { ">": [{ var: "x" }, 1] }] },
        data
      )
    ).toBe(false);
    expect(
      evaluateRule({ or: [{ "==": [{ var: "status" }, "FAILED"] }, { "!!": [1] }] }, data)
    ).toBe(true);
  });

  it("checks membership in arrays and strings", () => {
    expect(evaluateRule({ in: ["ou2", { var: "context.step_0_output.orgUnits" }] }, data)).toBe(
      true
    );
    expect(evaluateRule({ in: ["act", { var: "context.step_0_output.level" }] }, data)).toBe(true);
    expect(evaluateRule({ in: ["ou9", { var: "context.missing" }] }, data)).toBe(false);
  });

  it("negates", () => {
    expect(evaluateRule({ "!": [{ var: "context.step_1_output.count" }] }, data)).toBe(true);
  });
});

describe("isTruthy / ruleMatches", () => {
  it("treats an empty array as false", () => {
    expect(isTruthy([])).toBe(false);
    expect(isTruthy([0])).toBe(true);
  });

  it("passes when there is no rule", () => {
    expect(ruleMatches(null, data)).toBe(true);
    expect(ruleMatches(undefined, data)).toBe(true);
  });

  it("follows the rule otherwise", () => {
    expect(ruleMatches({ "==": [{ var: "status" }, "FAILED"] }, data)).toBe(false);
  });
});
