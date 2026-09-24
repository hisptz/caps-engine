import { z } from "zod";

const trainingPeriodSchema = z
  .object({
    endPeriod: z.string().min(1).optional(),
    periodOffset: z.number().int().min(0).optional(),
    numberOfPeriodsToGenerate: z.number().int().positive().default(3),
  })
  .refine(({ endPeriod, periodOffset }) => endPeriod !== undefined || periodOffset !== undefined, {
    message: "Either endPeriod or periodOffset must be set for the training period",
  });

export const predictionTriggerConfigSchema = z.object({
  backtestId: z.number().int().positive(),
  predictionSetupId: z.number().int().positive(),
  name: z.string().min(1),
  period: trainingPeriodSchema,
});

export type PredictionTriggerConfig = z.infer<typeof predictionTriggerConfigSchema>;

export const predictionTriggerContextSchema = z.object({
  period: trainingPeriodSchema,
});
