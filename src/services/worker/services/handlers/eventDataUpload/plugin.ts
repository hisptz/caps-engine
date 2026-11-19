import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";

export default definePlugin({
  key: Handlers.EVENT_DATA_UPLOAD,
  displayName: "Event Data Upload",
  description: "Uploads tracker events from a file to DHIS2",
  tags: ["dhis2", "alert"],
  outputs: {
    fields: [{ key: "created", label: "Events created", type: "number" }],
  },
  schemas: {},
  load: async () => (await import("./index.ts")).eventDataUpload,
});
