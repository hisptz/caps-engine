import { z } from "zod";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  fixedPullPeriodSchema,
  type PullPeriodType,
} from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";

// ============================================================
// Fixed-range runs
// A run may cover a fixed range of periods instead of each step's rolling window, e.g. to
// backfill history. The range reaches every step that fetches data for a period.
// ============================================================

/** Sortable number for a weekly (2024W1) or monthly (202401) period ID. */
function periodOrdinal(periodId: string, periodType: PullPeriodType): number {
  if (periodType === "MONTHLY") return Number(periodId);
  const [year, week] = periodId.split("W");
  return Number(year) * 100 + Number(week);
}

export const runPeriodRangeSchema = fixedPullPeriodSchema
  .transform(({ periodType, start, end }) => ({ periodType, start, end }))
  .refine(
    ({ periodType, start, end }) =>
      periodOrdinal(start, periodType) <= periodOrdinal(end, periodType),
    { message: "The range ends before it starts", path: ["end"] }
  );

export const runPeriodRangeInput = z.object({
  mode: z.literal("fixed").default("fixed"),
  periodType: z.enum(["WEEKLY", "MONTHLY"]),
  start: z.string().min(1),
  end: z.string().min(1),
});

export type RunPeriodRange = { periodType: PullPeriodType; start: string; end: string };

type PeriodStep = { handlerKey: string; handlerConfig: unknown };

export type StepPeriodOverride =
  | { kind: "override"; override: Record<string, unknown> }
  | { kind: "mismatch"; reason: string }
  | { kind: "none" };

function configuredPeriodType(config: unknown): string | undefined {
  const period = (config as { period?: { periodType?: unknown } } | null)?.period;
  return typeof period?.periodType === "string" ? period.periodType : undefined;
}

/**
 * The context override that makes one step cover the range. Steps without periods get none;
 * a step whose own period type differs (e.g. daily climate data) keeps its own window,
 * since its values would not match the range's periods.
 */
export function periodOverrideForStep(step: PeriodStep, range: RunPeriodRange): StepPeriodOverride {
  const own = configuredPeriodType(step.handlerConfig);
  switch (step.handlerKey as Handlers) {
    case Handlers.CLIMATE_OPENEO_CREATE: {
      const periodType = range.periodType.toLowerCase();
      if (own !== undefined && own !== periodType) {
        return { kind: "mismatch", reason: `Uses ${own} periods` };
      }
      return {
        kind: "override",
        override: { period: { mode: "fixed", periodType, id: range.start, endId: range.end } },
      };
    }
    case Handlers.DHIS2_INSTANCE_PULL:
    case Handlers.DHIS2_DATA_CHECK: {
      if (own !== undefined && own !== range.periodType) {
        return { kind: "mismatch", reason: `Uses ${own.toLowerCase()} periods` };
      }
      return {
        kind: "override",
        override: { period: { mode: "fixed", ...range } },
      };
    }
    default:
      return { kind: "none" };
  }
}
