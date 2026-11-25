import { z } from "zod";
import { capsField } from "@/shared/handlers/fields.ts";
import { GEOSERVICE_PIPELINE_ID_PATTERN } from "@/shared/clients/geoservicePipelines.ts";
import { climatePeriodSchema } from "../../climateOpenEo/schemas/config.ts";

export const geoservicePipelineRunConfigSchema = z.object({
  pipelineId: capsField(
    z.string().regex(GEOSERVICE_PIPELINE_ID_PATTERN).meta({ title: "Geoservice pipeline" }),
    "ocsPipeline"
  ),
  period: capsField(climatePeriodSchema.meta({ title: "Period" }), "climatePeriod"),
  mode: z.enum(["live", "dry_run"]).default("live").meta({
    title: "Delivery",
    description: "dry_run has DHIS2 check the values without writing them.",
  }),
});

export type GeoservicePipelineRunConfig = z.infer<typeof geoservicePipelineRunConfigSchema>;

/** A run or schedule may cover other periods; what it leaves out comes from the step. */
export const geoservicePipelineRunContextSchema = z.object({
  period: climatePeriodSchema.optional(),
});
