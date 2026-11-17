import { z } from "zod";
import {
  asyncQuerySchema,
  syncPlanQuerySchema,
} from "@/services/api/utils/climate/schemas/query.schema.ts";
import { createIngestionSchema } from "@/services/api/utils/climate/schemas/createIngestion.schema.ts";
import { syncDatasetSchema } from "@/services/api/utils/climate/schemas/syncDataset.schema.ts";

export const collectionIdParams = z.object({ id: z.string().min(1) });
export const dataSourceIdParams = z.object({ id: z.string().min(1) });
export const ingestionIdParams = z.object({ ingestionId: z.string().min(1) });
export const jobIdParams = z.object({ jobId: z.string().min(1) });
export const syncDatasetIdParams = z.object({ datasetId: z.string().min(1) });

export { asyncQuerySchema, syncPlanQuerySchema, createIngestionSchema, syncDatasetSchema };

export type AsyncQuery = z.infer<typeof asyncQuerySchema>;
export type SyncPlanQuery = z.infer<typeof syncPlanQuerySchema>;
export type CreateIngestionBody = z.infer<typeof createIngestionSchema>;
export type SyncDatasetBody = z.infer<typeof syncDatasetSchema>;

const ocsPipelineDefinitionSchema = z.object({
  name: z.string().nullish(),
  workflow: z.object({
    id: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  destination: z.object({
    plugin: z.string().min(1),
    settings: z.record(z.string(), z.unknown()).default({}),
  }),
  /** The policy is always `manual` (CAPS starts the runs), so only the mode is taken. */
  delivery: z
    .object({ mode: z.enum(["dry_run", "live", "paused"]) })
    .partial()
    .optional(),
});

export const ocsPipelineIdParams = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
});
export const ocsPipelineModeParams = ocsPipelineIdParams.extend({
  mode: z.enum(["dry_run", "live", "paused"]),
});
export const ocsPipelineCreateSchema = ocsPipelineDefinitionSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: "Start with a letter or digit; use only letters, digits, '_' or '-'",
  }),
});
export const ocsPipelineChangeSchema = ocsPipelineDefinitionSchema.extend({
  revision: z.number().int().positive(),
});
export const ocsPipelineIntervalSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

export type OcsPipelineCreateBody = z.infer<typeof ocsPipelineCreateSchema>;
export type OcsPipelineChangeBody = z.infer<typeof ocsPipelineChangeSchema>;
export type OcsPipelineIntervalBody = z.infer<typeof ocsPipelineIntervalSchema>;
