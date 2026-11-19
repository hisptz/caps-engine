import { Handlers } from "@/services/worker/constants/handlers.ts";
import { definePlugin } from "@/shared/handlers/plugin.ts";
import { predictionDataDownloadConfigSchema } from "./schemas/config.ts";

export default definePlugin({
  key: Handlers.PREDICTION_DATA_DOWNLOAD,
  displayName: "Prediction Data Download",
  description: "Download prediction data from CHAP",
  tags: ["prediction", "chap"],
  outputs: {
    fields: [{ key: "count", label: "Values downloaded", type: "number" }],
  },
  schemas: {
    config: predictionDataDownloadConfigSchema,
  },
  load: async () => (await import("./index.ts")).predictionDataDownload,
});
