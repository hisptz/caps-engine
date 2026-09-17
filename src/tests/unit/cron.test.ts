import { describe, expect, it } from "vitest";
import { assertCronExpr, cronExprSchema, InvalidCronExpressionError } from "@/shared/utils/cron.ts";

describe("assertCronExpr", () => {
  it("accepts a 5-part expression", () => {
    expect(assertCronExpr(" 0 6 * * * ")).toBe("0 6 * * *");
  });

  it("rejects a 6-part seconds expression", () => {
    expect(() => assertCronExpr("* * * * * *")).toThrow(InvalidCronExpressionError);
  });

  it("rejects garbage", () => {
    expect(() => assertCronExpr("not a cron")).toThrow(InvalidCronExpressionError);
  });
});

describe("cronExprSchema", () => {
  it("parses a valid 5-part expression", () => {
    expect(cronExprSchema.parse("0 4 * * 1")).toBe("0 4 * * 1");
  });

  it("rejects empty and invalid expressions", () => {
    expect(cronExprSchema.safeParse("").success).toBe(false);
    expect(cronExprSchema.safeParse("* * * * * *").success).toBe(false);
  });
});
