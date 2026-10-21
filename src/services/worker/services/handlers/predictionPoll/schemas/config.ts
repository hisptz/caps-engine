import { z } from "zod";

export const DEFAULT_PREDICTION_POLL = {
  intervalSeconds: 30,
  timeoutHours: 6,
};

/**
 * How the step waits for its CHAP job. It checks the job's status every `intervalSeconds`
 * until CHAP reports success or failure; `timeoutHours` is only a safety net for a job left
 * STARTED for good (e.g. its worker died), set above CHAP's own two-hour model timeout.
 */
export const predictionPollConfigSchema = z.object({
  polling: z
    .object({
      intervalSeconds: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .default(DEFAULT_PREDICTION_POLL.intervalSeconds),
      timeoutHours: z.number().min(0.25).max(72).default(DEFAULT_PREDICTION_POLL.timeoutHours),
    })
    .default(DEFAULT_PREDICTION_POLL),
});

export type PredictionPollConfig = z.infer<typeof predictionPollConfigSchema>;
