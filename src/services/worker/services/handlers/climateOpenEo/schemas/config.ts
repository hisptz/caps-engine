import { z } from "zod";
import type { ClimatePeriodType } from "@/services/worker/utils/period.ts";

const periodTypeSchema = z.enum(["daily", "weekly", "monthly"]);

/** Longest rolling window per period type: about a year of days, two years of weeks, three of months. */
export const MAX_ROLLING_COUNT: Record<ClimatePeriodType, number> = {
  daily: 400,
  weekly: 104,
  monthly: 36,
};

const fixedPeriodSchema = z.strictObject({
  mode: z.literal("fixed").optional(),
  periodType: periodTypeSchema,
  /** First period covered by the run. */
  id: z.string().min(1),
  /** Last period covered by the run. Omitted for a single-period run. */
  endId: z.string().min(1).optional(),
});

const rollingPeriodSchema = z.strictObject({
  mode: z.literal("rolling"),
  periodType: periodTypeSchema,
  count: z.number().int().min(1),
  /** Periods skipped at the end; 1 (the default) stops at the last complete period. */
  offset: z.number().int().min(0).max(366).optional(),
});

/** Earlier form of a daily rolling window ending yesterday, kept for existing configs. */
const lastDaysPeriodSchema = z.strictObject({
  periodType: z.literal("daily"),
  lastDays: z.number().int().min(1),
});

const periodSchema = z
  .union([fixedPeriodSchema, rollingPeriodSchema, lastDaysPeriodSchema])
  .superRefine((period, ctx) => {
    const count = "lastDays" in period ? period.lastDays : "count" in period ? period.count : null;
    const max = MAX_ROLLING_COUNT[period.periodType];
    if (count !== null && count > max) {
      ctx.addIssue({
        code: "custom",
        message: `A rolling ${period.periodType} window covers at most ${max} periods`,
        path: ["lastDays" in period ? "lastDays" : "count"],
      });
    }
  });

export const climateOpenEoConfigSchema = z
  .object({
    datasetId: z.string().min(1),
    /**
     * Named DHIS2 export declared under `exports` in the Open Climate Service instance
     * config. It owns the data element mapping and the period type of the dataValueSet.
     * Same id rule as OCS (`exports/service.py`).
     */
    exportId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .optional(),
    /**
     * Data element the values are written to, mapped in CAPS rather than in OCS config.
     * Rendered with OCS's ad-hoc `save_result` DHIS2JSON options.
     */
    variable: z
      .object({
        dataElement: z.string().regex(/^[A-Za-z0-9]{11}$/),
      })
      .optional(),
    aggregation: z.object({
      method: z.enum(["mean", "min", "max", "sum"]),
    }),
    period: periodSchema,
    orgUnit: z
      .object({
        levels: z.array(z.string()).optional(),
        ids: z.array(z.string()).optional(),
      })
      .refine((o) => (o.levels && o.levels.length > 0) || (o.ids && o.ids.length > 0), {
        message: "At least one of levels or ids must be non-empty",
      }),
  })
  .refine((c) => (c.exportId === undefined) !== (c.variable === undefined), {
    message: "Set exactly one of exportId or variable.dataElement",
    path: ["exportId"],
  });

export type ClimateOpenEoConfig = z.infer<typeof climateOpenEoConfigSchema>;

/**
 * A run or schedule overrides either part on its own; what it leaves out comes from the step,
 * including later edits, so a schedule without a period follows a rolling step as it moves.
 */
export const climateOpenEoContextSchema = z.object({
  period: periodSchema.optional(),
  orgUnit: z
    .object({
      levels: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .refine((o) => (o.levels && o.levels.length > 0) || (o.ids && o.ids.length > 0), {
      message: "At least one of levels or ids must be non-empty",
    })
    .optional(),
});
