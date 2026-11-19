import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { alertGenerationConfigSchema, alertGenerationContextSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.ALERT_GENERATION,
  displayName: "Alert Generation",
  description: "Compares aggregate values against thresholds and generates DHIS2 tracker events",
  tags: ["alert", "dhis2"],
  outputs: {
    fields: [{ key: "count", label: "Alerts raised", type: "number" }],
  },
  schemas: {
    config: alertGenerationConfigSchema,
    context: alertGenerationContextSchema,
  },
  load: async () => (await import("./index.ts")).alertGeneration,
});
