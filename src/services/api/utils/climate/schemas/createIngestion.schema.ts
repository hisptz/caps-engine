import { z } from "zod";

export const createIngestionSchema = z.object({
  dataset_id: z.string().min(1),
  start: z.string().min(1).nullable().optional(),
  end: z.string().nullable().optional(),
  overwrite: z.boolean().optional().default(false),
  publish: z.boolean().optional().default(true),
});

export type CreateIngestionInput = z.infer<typeof createIngestionSchema>;
