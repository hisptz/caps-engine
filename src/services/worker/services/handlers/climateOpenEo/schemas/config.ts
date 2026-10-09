import { z } from "zod";

const periodSchema = z
  .object({
    periodType: z.enum(["daily", "weekly", "monthly"]),
    /** First period covered by the run. Takes precedence over `lastDays`. */
    id: z.string().min(1).optional(),
    /**
     * Last period covered by the run. Omitted for a single-period run
     */
    endId: z.string().min(1).optional(),
    /**
     * Without `id`: cover the `lastDays` days up to and including yesterday (UTC), worked
     * out when the step runs, so a scheduled pipeline picks up recent and revised data.
     */
    lastDays: z.number().int().positive().optional(),
  })
  .refine((p) => p.id !== undefined || p.lastDays !== undefined, {
    message: "Either id or lastDays must be set",
  });

export const climateOpenEoConfigSchema = z.object({
  datasetId: z.string().min(1),
  /**
   * Named DHIS2 export declared under `exports` in the Open Climate Service instance
   * config. It owns the data element mapping and the period type of the dataValueSet.
   */
  exportId: z.string().regex(/^[A-Za-z0-9_-]+$/),
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
});

export type ClimateOpenEoConfig = z.infer<typeof climateOpenEoConfigSchema>;

export const climateOpenEoContextSchema = z.object({
  period: periodSchema,
  orgUnit: z
    .object({
      levels: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .refine((o) => (o.levels && o.levels.length > 0) || (o.ids && o.ids.length > 0), {
      message: "At least one of levels or ids must be non-empty",
    }),
});
