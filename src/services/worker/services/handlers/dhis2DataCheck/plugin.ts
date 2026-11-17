import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { dhis2InstancePullContextSchema } from "../dhis2InstancePull/schemas/config.ts";
import { dhis2DataCheckConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.DHIS2_DATA_CHECK,
  displayName: "DHIS2 Data Check",
  description:
    "Check whether data is already in DHIS2: count the values entered for chosen data elements, org units and periods",
  tags: ["dhis2"],
  outputs: {
    fields: [
      { key: "found", label: "Values found", type: "number" },
      { key: "expected", label: "Values expected", type: "number" },
      { key: "completeness", label: "Completeness (%)", type: "number" },
    ],
  },
  schemas: {
    config: dhis2DataCheckConfigSchema,
    context: dhis2InstancePullContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).dhis2DataCheck,
});
