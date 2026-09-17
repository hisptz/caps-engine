import { z } from "zod";

export const asyncQuerySchema = z.object({
  async: z.coerce.boolean().optional().default(true),
});

export const syncPlanQuerySchema = z.object({
  end: z.string().optional(),
});

export type AsyncQueryInput = z.infer<typeof asyncQuerySchema>;
export type SyncPlanQueryInput = z.infer<typeof syncPlanQuerySchema>;
