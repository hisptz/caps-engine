import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";

export default definePlugin({
  key: Handlers.CLIMATE_OPENEO_DOWNLOAD,
  displayName: "Open Climate Service Download",
  description: "Download DHIS2 data values from a finished Open Climate Service job",
  tags: ["climate", "openeo"],
  outputs: {
    fields: [{ key: "count", label: "Values downloaded", type: "number" }],
  },
  schemas: {},
  load: async () => (await import("./index.ts")).climateOpenEoDownload,
});
