import { z } from "zod";
import { cronExprSchema } from "@/shared/utils/cron.ts";
import { runPeriodRangeInput } from "@/shared/pipeline/runPeriod.ts";

export const idParams = z.object({ id: z.uuid("Invalid workflow ID") });
export const memberParams = z.object({
  id: z.uuid("Invalid workflow ID"),
  pipelineId: z.uuid("Invalid pipeline ID"),
});
export const runIdParams = z.object({ runId: z.uuid("Invalid workflow run ID") });

export const createWorkflowBody = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    isActive: z.boolean().default(true),
    cronExpr: cronExprSchema.nullable().optional(),
  })
  .strict();

export const updateWorkflowBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
    cronExpr: cronExprSchema.nullable().optional(),
  })
  .strict();

export const runWorkflowBody = z
  .object({
    /** Cover this range instead of each step's own window, e.g. to backfill history */
    period: runPeriodRangeInput.optional(),
  })
  .strict();

export const listWorkflowRunsQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export type CreateWorkflowBody = z.infer<typeof createWorkflowBody>;
export type UpdateWorkflowBody = z.infer<typeof updateWorkflowBody>;
export type RunWorkflowBody = z.infer<typeof runWorkflowBody>;
export type ListWorkflowRunsQuery = z.infer<typeof listWorkflowRunsQuery>;
