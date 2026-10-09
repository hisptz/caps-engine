import { z } from "zod";

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
  period: z.object({
    periodType: z.enum(["daily", "weekly", "monthly"]),
    /** First period covered by the run. */
    id: z.string().min(1),
    /**
     * Last period covered by the run. Omitted for a single-period run
     */
    endId: z.string().min(1).optional(),
  }),
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
  period: z.object({
    periodType: z.enum(["daily", "weekly", "monthly"]),
    id: z.string(),
    endId: z.string().min(1).optional(),
  }),
  orgUnit: z
    .object({
      levels: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .refine((o) => (o.levels && o.levels.length > 0) || (o.ids && o.ids.length > 0), {
      message: "At least one of levels or ids must be non-empty",
    }),
});
