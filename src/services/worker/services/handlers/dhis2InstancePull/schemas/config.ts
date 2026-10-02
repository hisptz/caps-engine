import { z } from "zod";
import { orgUnitConfigSchema } from "@/services/worker/schemas/orgUnit.ts";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";

const uidSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

export const pullPeriodTypeSchema = z.enum(["WEEKLY", "MONTHLY"]);

export type PullPeriodType = z.infer<typeof pullPeriodTypeSchema>;

const PERIOD_ID_PATTERNS: Record<PullPeriodType, RegExp> = {
  MONTHLY: /^\d{4}(0[1-9]|1[0-2])$/,
  WEEKLY: /^\d{4}W(0?[1-9]|[1-4]\d|5[0-3])$/,
};

const PERIOD_ID_EXAMPLES: Record<PullPeriodType, string> = {
  MONTHLY: "202401",
  WEEKLY: "2024W1",
};

export const fixedPullPeriodSchema = z
  .object({
    mode: z.literal("fixed"),
    periodType: pullPeriodTypeSchema,
    start: z.string().min(1),
    end: z.string().min(1),
  })
  .superRefine((period, ctx) => {
    const pattern = PERIOD_ID_PATTERNS[period.periodType];
    for (const key of ["start", "end"] as const) {
      if (!pattern.test(period[key])) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Use a ${period.periodType.toLowerCase()} period ID like ${PERIOD_ID_EXAMPLES[period.periodType]}`,
        });
      }
    }
  });

export const relativePullPeriodSchema = z.object({
  mode: z.literal("relative"),
  periodType: pullPeriodTypeSchema,
  count: z.number().int().min(1).max(260),
  offset: z.number().int().min(0).default(1),
});

export const pullPeriodSchema = z.discriminatedUnion("mode", [
  fixedPullPeriodSchema,
  relativePullPeriodSchema,
]);

export type PullPeriod = z.infer<typeof pullPeriodSchema>;

export const pullItemTypeSchema = z.enum(["DATA_ELEMENT", "INDICATOR", "PROGRAM_INDICATOR"]);

export const pullItemSchema = z
  .object({
    from: uidSchema,
    fromType: pullItemTypeSchema,
    into: uidSchema.optional(),
  })
  .refine((item) => item.fromType === "DATA_ELEMENT" || item.into !== undefined, {
    message: "Indicators and program indicators need a staging data element to write into",
    path: ["into"],
  });

export type PullItem = z.infer<typeof pullItemSchema>;

export function pullItemTarget(item: PullItem): string {
  return item.into ?? item.from;
}

export const dhis2InstancePullConfigSchema = z.object({
  routeCode: z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
    message: "Pick a connected instance (route code starting with caps-src-)",
  }),
  items: z
    .array(pullItemSchema)
    .min(1)
    .superRefine((items, ctx) => {
      const seenFrom = new Set<string>();
      const seenInto = new Set<string>();
      items.forEach((item, index) => {
        if (seenFrom.has(item.from)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "from"],
            message: "Each source item may only be listed once",
          });
        }
        seenFrom.add(item.from);
        const target = pullItemTarget(item);
        if (seenInto.has(target)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "into"],
            message: "Two items write into the same staging data element",
          });
        }
        seenInto.add(target);
      });
    }),
  orgUnit: orgUnitConfigSchema,
  period: pullPeriodSchema,
  chunk: z
    .object({
      periods: z.number().int().min(1).max(60).default(12),
      orgUnits: z.number().int().min(1).max(500).default(50),
    })
    .default({ periods: 12, orgUnits: 50 }),
});

export type Dhis2InstancePullConfig = z.infer<typeof dhis2InstancePullConfigSchema>;

/**
 * A run may replace the period, e.g. with a fixed range to backfill history. Without one the
 * step's own period is used, so schedules follow later edits to the step.
 */
export const dhis2InstancePullContextSchema = z.object({
  period: pullPeriodSchema.optional(),
});
