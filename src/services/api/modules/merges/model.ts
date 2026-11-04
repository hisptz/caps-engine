import { z } from "zod";
import { MergeRunStatus, MergeTriggerRule } from "@db/client";
import { validateRule } from "@/shared/pipeline/rules.ts";
import { MAX_MERGE_TIMEOUT_MINUTES } from "@/shared/pipeline/merges.ts";

export const idParams = z.object({ id: z.uuid("Invalid merge ID") });
export const mergeRunIdParams = z.object({ id: z.uuid("Invalid merge run ID") });

const conditionSchema = z
  .unknown()
  .nullable()
  .superRefine((rule, ctx) => {
    const error = rule === null || rule === undefined ? null : validateRule(rule);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

const sourcesSchema = z
  .array(z.uuid("Invalid source pipeline ID"))
  .min(2, "A connector that waits for all needs at least two pipelines")
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, "Each source pipeline can be listed once");

export const listMergesQuery = z.object({
  workflowId: z.uuid("Invalid workflow ID").optional(),
  /** Merges that wait for this pipeline or start it */
  pipelineId: z.uuid("Invalid pipeline ID").optional(),
});

export const createMergeBody = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    workflowId: z.uuid("Invalid workflow ID"),
    sourcePipelineIds: sourcesSchema,
    targetPipelineId: z.uuid("Invalid target pipeline ID"),
    triggerRule: z.enum(MergeTriggerRule).default(MergeTriggerRule.ALL_SUCCEEDED),
    timeoutMinutes: z.number().int().min(1).max(MAX_MERGE_TIMEOUT_MINUTES).default(1440),
    condition: conditionSchema.optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

/** The workflow cannot change. */
export const updateMergeBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    sourcePipelineIds: sourcesSchema.optional(),
    targetPipelineId: z.uuid("Invalid target pipeline ID").optional(),
    triggerRule: z.enum(MergeTriggerRule).optional(),
    timeoutMinutes: z.number().int().min(1).max(MAX_MERGE_TIMEOUT_MINUTES).optional(),
    condition: conditionSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const listMergeRunsQuery = z.object({
  status: z.enum(MergeRunStatus).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export type ListMergesQuery = z.infer<typeof listMergesQuery>;
export type CreateMergeBody = z.infer<typeof createMergeBody>;
export type UpdateMergeBody = z.infer<typeof updateMergeBody>;
export type ListMergeRunsQuery = z.infer<typeof listMergeRunsQuery>;
