import { z } from "zod";

export const openClimateServiceSyncConfigSchema = z.object({
  datasetIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Each dataset may only be listed once",
    }),
  /**
   * Last period to sync to. Omitted, each dataset syncs to the latest data its source has
   * published, which is what a scheduled run wants.
   */
  end: z.iso.date({ message: "Use a date in YYYY-MM-DD format" }).optional(),
  onFailure: z.enum(["fail", "continue"]).default("fail"),
  polling: z
    .object({
      pollIntervalMs: z.number().int().min(1_000).default(10_000),
      maxAttempts: z.number().int().min(1).default(150),
    })
    .default({ pollIntervalMs: 10_000, maxAttempts: 150 }),
});

export type OpenClimateServiceSyncConfig = z.infer<typeof openClimateServiceSyncConfigSchema>;
