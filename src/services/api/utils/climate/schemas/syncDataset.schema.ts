import { z } from "zod";

export const syncDatasetSchema = z.object({
  end: z.string().nullable().optional(),
  publish: z.boolean().optional().default(true),
});

export type SyncDatasetInput = z.infer<typeof syncDatasetSchema>;
