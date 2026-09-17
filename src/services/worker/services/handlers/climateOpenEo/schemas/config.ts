import { z } from "zod";

export const climateOpenEoConfigSchema = z.object({
  datasetId: z.string().min(1),
  variable: z.object({
    dataElement: z.string().regex(/^[A-Za-z0-9]{11}$/),
  }),
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
