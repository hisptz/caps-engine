import { z } from "zod";
import { capsField } from "@/shared/handlers/fields.ts";
import { OCS_PIPELINE_ID_PATTERN } from "@/shared/clients/ocsPipelines.ts";
import { climatePeriodSchema } from "../../climateOpenEo/schemas/config.ts";

const pollingSchema = z
  .object({
    intervalSeconds: z.number().int().min(5).max(3600).default(15),
    timeoutHours: z.number().min(0.1).max(72).default(6),
  })
  .default({ intervalSeconds: 15, timeoutHours: 6 });

export const ocsPipelineRunConfigSchema = z.object({
  pipelineId: capsField(
    z.string().regex(OCS_PIPELINE_ID_PATTERN).meta({
      title: "OCS pipeline",
      description:
        "The Open Climate Service pipeline this step runs: its workflow, inputs and DHIS2 mapping.",
    }),
    "ocsPipeline"
  ),
  period: capsField(
    climatePeriodSchema.meta({
      title: "Period",
      description: "The interval each run covers; a rolling window moves with the run date.",
    }),
    "climatePeriod"
  ),
  mode: z.enum(["live", "dry_run"]).default("live").meta({
    title: "Delivery",
    description:
      "live writes the values to DHIS2 (the OCS pipeline must be live); dry_run has DHIS2 check them without writing.",
  }),
  polling: pollingSchema.optional(),
});

export type OcsPipelineRunConfig = z.infer<typeof ocsPipelineRunConfigSchema>;

/** A run or schedule may cover other periods; what it leaves out comes from the step. */
export const ocsPipelineRunContextSchema = z.object({
  period: climatePeriodSchema.optional(),
});
