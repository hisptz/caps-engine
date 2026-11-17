import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { openClimateServiceSyncConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.OPEN_CLIMATE_SERVICE_SYNC,
  displayName: "Open Climate Service Sync",
  description: "Bring Open Climate Service datasets up to date before the pipeline reads them",
  tags: ["climate", "sync"],
  outputs: { fields: [] },
  schemas: {
    config: openClimateServiceSyncConfigSchema,
  },
  load: async () => (await import("./index.ts")).openClimateServiceSync,
});
