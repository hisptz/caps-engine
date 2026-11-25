import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { openGeoServiceSyncConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.OPEN_GEO_SERVICE_SYNC,
  displayName: "Open Geo Service Sync",
  description: "Bring Open Geo Service datasets up to date before the pipeline reads them",
  tags: ["climate", "sync"],
  outputs: { fields: [] },
  schemas: {
    config: openGeoServiceSyncConfigSchema,
  },
  load: async () => (await import("./index.ts")).openGeoServiceSync,
});
