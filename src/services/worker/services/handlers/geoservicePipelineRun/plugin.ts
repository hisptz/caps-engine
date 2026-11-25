import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import {
  geoservicePipelineRunConfigSchema,
  geoservicePipelineRunContextSchema,
} from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.GEOSERVICE_PIPELINE_RUN,
  displayName: "Geoservice Pipeline Run",
  description:
    "Run an Open Geo Service pipeline over a period and wait until geoservice has delivered the values to DHIS2",
  tags: ["climate", "geoservice"],
  outputs: {
    fields: [
      { key: "submitted", label: "Values sent to DHIS2", type: "number" },
      { key: "conflicts", label: "Values DHIS2 refused", type: "number" },
    ],
  },
  schemas: {
    config: geoservicePipelineRunConfigSchema,
    context: geoservicePipelineRunContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).geoservicePipelineRun,
});
