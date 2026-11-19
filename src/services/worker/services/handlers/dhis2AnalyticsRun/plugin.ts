import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2AnalyticsRunConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_ANALYTICS_RUN,
  displayName: "DHIS2 Analytics Run",
  description: "Triggers DHIS2 analytics table generation and polls for completion",
  tags: ["dhis2", "analytics"],
  outputs: { fields: [] },
  schemas: {
    config: dhis2AnalyticsRunConfigSchema,
  },
  load: async () => (await import("./index.ts")).dhis2AnalyticsRun,
});
