import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2InstancePushConfigSchema, dhis2InstancePushContextSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_INSTANCE_PUSH,
  displayName: "DHIS2 Instance Push",
  description: "Sends data values from staging to another DHIS2 instance through a staging route",
  tags: ["dhis2", "push"],
  outputs: { fields: [] },
  schemas: {
    config: dhis2InstancePushConfigSchema,
    context: dhis2InstancePushContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).dhis2InstancePush,
});
