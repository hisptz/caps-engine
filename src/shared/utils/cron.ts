import { Cron } from "croner";
import { z } from "zod";
import { getServerTimezone } from "@/shared/utils/timezone.ts";

export const CRON_PATTERN_MODE = "5-part" as const;

export class InvalidCronExpressionError extends Error {
  constructor(expression: string, cause?: unknown) {
    super(`Invalid 5-part cron expression: ${expression}`);
    this.name = "InvalidCronExpressionError";
    this.cause = cause;
  }
}

/** Parse and accept only traditional 5-field cron (minute hour day month weekday). */
export function assertCronExpr(expression: string, timezone: string = getServerTimezone()): string {
  const trimmed = expression.trim();
  try {
    new Cron(trimmed, { timezone, mode: CRON_PATTERN_MODE, paused: true });
  } catch (err) {
    throw new InvalidCronExpressionError(trimmed, err);
  }
  return trimmed;
}

export const cronExprSchema = z
  .string()
  .trim()
  .min(1, "Cron expression is required")
  .superRefine((value, ctx) => {
    try {
      assertCronExpr(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid 5-part cron expression",
      });
    }
  });
