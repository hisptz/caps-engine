import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";

export default definePlugin({
  key: Handlers.CLIMATE_OPENEO_POLL,
  displayName: "Open Geo Service Poll",
  description: "Poll an Open Geo Service job until it finishes",
  tags: ["climate", "openeo"],
  outputs: { fields: [] },
  schemas: {},
  load: async () => (await import("./index.ts")).climateOpenEoPoll,
});
