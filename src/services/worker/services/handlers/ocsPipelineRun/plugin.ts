import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { ocsPipelineRunConfigSchema, ocsPipelineRunContextSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.OCS_PIPELINE_RUN,
  displayName: "OCS Pipeline Run",
  description:
    "Run an Open Climate Service pipeline over a period and wait until OCS has delivered the values to DHIS2",
  tags: ["climate", "ocs"],
  outputs: {
    fields: [
      { key: "submitted", label: "Values sent to DHIS2", type: "number" },
      { key: "conflicts", label: "Values DHIS2 refused", type: "number" },
    ],
  },
  schemas: {
    config: ocsPipelineRunConfigSchema,
    context: ocsPipelineRunContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).ocsPipelineRun,
});
