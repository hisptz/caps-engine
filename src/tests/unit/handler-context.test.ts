import { describe, it, expect } from "vitest";
import { hasHandlerContextSchema, validateHandlerContext } from "@/shared/handlers/catalog.ts";

describe("validateHandlerContext", () => {
  it("returns true for handlers without context schema", () => {
    expect(hasHandlerContextSchema("prediction-poll")).toBe(false);
    expect(validateHandlerContext("prediction-poll", { anything: 1 }).success).toBe(true);
  });

  it("accepts valid prediction-trigger context slice", () => {
    const result = validateHandlerContext("prediction-trigger", {
      orgUnit: { ids: ["ou1"] },
      period: {
        type: "MONTHLY",
        periodOffset: 0,
        numberPreviousYearsToInclude: 2,
        numberOfPeriodsToGenerate: 3,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid period type on prediction-trigger", () => {
    const result = validateHandlerContext("prediction-trigger", {
      orgUnit: { ids: ["ou1"] },
      period: {
        type: "INVALID",
        periodOffset: 0,
        numberPreviousYearsToInclude: 2,
        numberOfPeriodsToGenerate: 3,
      },
    });
    expect(result.success).toBe(false);
  });
});
