import { z } from "zod";

export const predictionDataDownloadConfigSchema = z.object({
  dataElementIds: z.record(z.string(), z.string().min(1)).optional(),
});

export type PredictionDataDownloadConfig = z.infer<typeof predictionDataDownloadConfigSchema>;
