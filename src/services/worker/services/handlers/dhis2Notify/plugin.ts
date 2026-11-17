import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2NotifyConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_NOTIFY,
  displayName: "DHIS2 Notify",
  description: "Sends a DHIS2 message (and email, when SMTP is configured) to users or user groups",
  tags: ["dhis2", "notification"],
  outputs: { passThrough: true },
  schemas: {
    config: dhis2NotifyConfigSchema,
  },
  load: async () => (await import("./index.ts")).dhis2Notify,
});
