import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import {
  thresholdGenerationConfigSchema,
  thresholdGenerationContextSchema,
} from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.THRESHOLD_GENERATION,
  displayName: "Threshold Generation",
  description: "Generates thresholds for Malaria Alerts",
  tags: ["threshold"],
  outputs: {
    fields: [{ key: "count", label: "Thresholds generated", type: "number" }],
  },
  schemas: {
    config: thresholdGenerationConfigSchema,
    context: thresholdGenerationContextSchema,
  },
  load: async () => (await import("./index.ts")).thresholdGeneration,
});
