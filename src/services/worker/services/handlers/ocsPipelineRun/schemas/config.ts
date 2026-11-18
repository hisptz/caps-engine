import { z } from "zod";
import { capsField } from "@/shared/handlers/fields.ts";
import { OCS_PIPELINE_ID_PATTERN } from "@/shared/clients/ocsPipelines.ts";
import { climatePeriodSchema } from "../../climateOpenEo/schemas/config.ts";

export const ocsPipelineRunConfigSchema = z.object({
  pipelineId: capsField(
    z.string().regex(OCS_PIPELINE_ID_PATTERN).meta({ title: "OCS pipeline" }),
    "ocsPipeline"
  ),
  period: capsField(climatePeriodSchema.meta({ title: "Period" }), "climatePeriod"),
  mode: z.enum(["live", "dry_run"]).default("live").meta({
    title: "Delivery",
    description: "dry_run has DHIS2 check the values without writing them.",
  }),
});

export type OcsPipelineRunConfig = z.infer<typeof ocsPipelineRunConfigSchema>;

/** A run or schedule may cover other periods; what it leaves out comes from the step. */
export const ocsPipelineRunContextSchema = z.object({
  period: climatePeriodSchema.optional(),
});
