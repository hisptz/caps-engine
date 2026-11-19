import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import {
  climateOpenEoConfigSchema,
  climateOpenEoContextSchema,
} from "../climateOpenEo/schemas/config.ts";

export default definePlugin({
  key: Handlers.CLIMATE_OPENEO_CREATE,
  displayName: "Open Climate Service Create",
  description: "Create and start an Open Climate Service batch job for climate data aggregation",
  tags: ["climate", "openeo"],
  outputs: { fields: [] },
  schemas: {
    config: climateOpenEoConfigSchema,
    context: climateOpenEoContextSchema,
  },
  contextReplaces: ["period", "orgUnit"],
  load: async () => (await import("./index.ts")).climateOpenEoCreate,
});
