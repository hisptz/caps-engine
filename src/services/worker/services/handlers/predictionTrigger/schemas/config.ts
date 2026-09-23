import { z } from "zod";

export const predictionTriggerConfigSchema = z.object({
  backtestId: z.number().int().positive(),
  predictionSetupId: z.number().int().positive(),
  name: z.string().min(1),
  period: z
    .object({
      endPeriod: z.string().min(1).optional(),
      periodOffset: z.number().int().min(0).optional(),
      numberOfPeriodsToGenerate: z.number().int().positive().default(3),
    })
    .refine(
      ({ endPeriod, periodOffset }) => endPeriod !== undefined || periodOffset !== undefined,
      {
        message: "Either endPeriod or periodOffset must be set for the training period",
      }
    ),
});

export type PredictionTriggerConfig = z.infer<typeof predictionTriggerConfigSchema>;

/** Per-run overrides: a schedule ends the training window relative to each run. */
export const predictionTriggerContextSchema = z.object({
  period: z.object({
    periodOffset: z.number().default(0),
    numberOfPeriodsToGenerate: z.number().default(3),
  }),
});
