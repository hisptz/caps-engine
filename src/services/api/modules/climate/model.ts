import { z } from "zod";
import {
  asyncQuerySchema,
  syncPlanQuerySchema,
} from "@/services/api/utils/climate/schemas/query.schema.ts";
import { createIngestionSchema } from "@/services/api/utils/climate/schemas/createIngestion.schema.ts";
import { syncDatasetSchema } from "@/services/api/utils/climate/schemas/syncDataset.schema.ts";

export const datasetIdParams = z.object({ id: z.string().min(1) });
export const datasetTemplateIdParams = z.object({ id: z.string().min(1) });
export const ingestionIdParams = z.object({ ingestionId: z.string().min(1) });
export const jobIdParams = z.object({ jobId: z.string().min(1) });
export const syncDatasetIdParams = z.object({ datasetId: z.string().min(1) });

export { asyncQuerySchema, syncPlanQuerySchema, createIngestionSchema, syncDatasetSchema };

export type AsyncQuery = z.infer<typeof asyncQuerySchema>;
export type SyncPlanQuery = z.infer<typeof syncPlanQuerySchema>;
export type CreateIngestionBody = z.infer<typeof createIngestionSchema>;
export type SyncDatasetBody = z.infer<typeof syncDatasetSchema>;
