import { z } from "zod";
import { runPeriodRangeInput } from "@/shared/pipeline/runPeriod.ts";

export const templateParams = z.object({ template: z.string().min(1) });
export const workflowIdParams = z.object({ id: z.uuid("Invalid workflow ID") });

/** Parameters are checked by the template itself, so problems come back as a list */
export const previewTemplateBody = z.object({ params: z.unknown() }).strict();

export const createFromTemplateBody = z
  .object({
    params: z.unknown(),
    backfill: runPeriodRangeInput.optional(),
  })
  .strict();

export const updateTemplateSetupBody = z
  .object({
    params: z.unknown(),
    /** Overwrite pipelines whose steps were changed by hand since the template set them */
    force: z.boolean().default(false),
  })
  .strict();

export type CreateFromTemplateBody = z.infer<typeof createFromTemplateBody>;
export type UpdateTemplateSetupBody = z.infer<typeof updateTemplateSetupBody>;
