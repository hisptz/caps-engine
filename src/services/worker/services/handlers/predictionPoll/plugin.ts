import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { predictionPollConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.PREDICTION_POLL,
  displayName: "Prediction Poll",
  description:
    "Wait for the CHAP prediction job: checks its status until CHAP reports success or failure",
  tags: ["prediction", "chap"],
  outputs: { fields: [] },
  schemas: {
    config: predictionPollConfigSchema,
  },
  load: async () => (await import("./index.ts")).predictionPoll,
});
