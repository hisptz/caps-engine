import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2InstancePullConfigSchema, dhis2InstancePullContextSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_INSTANCE_PULL,
  displayName: "DHIS2 Instance Pull",
  description:
    "Pulls aggregate data from another DHIS2 instance through a staging route, into a file for DHIS2 Data Upload",
  tags: ["dhis2", "pull"],
  outputs: {
    fields: [{ key: "count", label: "Values pulled", type: "number" }],
  },
  schemas: {
    config: dhis2InstancePullConfigSchema,
    context: dhis2InstancePullContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).dhis2InstancePull,
});
