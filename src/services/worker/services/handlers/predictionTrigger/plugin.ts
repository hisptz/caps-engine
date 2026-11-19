import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { predictionTriggerConfigSchema, predictionTriggerContextSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.PREDICTION_TRIGGER,
  displayName: "Prediction Trigger",
  description: "Trigger prediction generation",
  tags: ["prediction", "chap"],
  outputs: { fields: [] },
  schemas: {
    config: predictionTriggerConfigSchema,
    context: predictionTriggerContextSchema,
  },
  contextReplaces: ["period"],
  load: async () => (await import("./index.ts")).predictionTrigger,
});
