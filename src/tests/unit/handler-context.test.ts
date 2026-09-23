import { describe, it, expect } from "vitest";
import { hasHandlerContextSchema, validateHandlerContext } from "@/shared/handlers/catalog.ts";

describe("validateHandlerContext", () => {
  it("returns true for handlers without context schema", () => {
    expect(hasHandlerContextSchema("prediction-poll")).toBe(false);
    expect(validateHandlerContext("prediction-poll", { anything: 1 }).success).toBe(true);
  });

  it("accepts valid prediction-trigger context slice", () => {
    const result = validateHandlerContext("prediction-trigger", {
      period: { periodOffset: 1, numberOfPeriodsToGenerate: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-numeric period offset on prediction-trigger", () => {
    const result = validateHandlerContext("prediction-trigger", {
      period: { periodOffset: "last", numberOfPeriodsToGenerate: 3 },
    });
    expect(result.success).toBe(false);
  });
});
