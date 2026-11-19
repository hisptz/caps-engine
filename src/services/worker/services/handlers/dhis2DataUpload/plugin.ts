import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2DataUploadConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_DATA_UPLOAD,
  displayName: "DHIS2 Data Upload",
  description: "Uploads data from a file to DHIS2",
  tags: ["dhis2"],
  outputs: {
    fields: [
      { key: "imported", label: "Values imported", type: "number" },
      { key: "updated", label: "Values updated", type: "number" },
      { key: "ignored", label: "Values ignored", type: "number" },
    ],
  },
  schemas: {
    config: dhis2DataUploadConfigSchema,
  },
  load: async () => (await import("./index.ts")).dhis2DataUpload,
});
