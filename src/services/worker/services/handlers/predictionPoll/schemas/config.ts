import { z } from "zod";

export const predictionPollConfigSchema = z.object({
  /**
   * Polling controls for watching the CHAP job. Training on a large dataset can take
   * well over the default ten minutes.
   */
  polling: z
    .object({
      pollIntervalMs: z.number().int().min(250).default(5_000),
      maxAttempts: z.number().int().min(1).default(120),
    })
    .default({
      pollIntervalMs: 5_000,
      maxAttempts: 120,
    }),
});

export type PredictionPollConfig = z.infer<typeof predictionPollConfigSchema>;
