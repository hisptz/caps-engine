import { z } from "zod";
import { PeriodTypeEnum } from "@hisptz/dhis2-utils";

const orgUnitSchema = z
  .object({
    levels: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
  })
  .refine((config) => {
    if (!config.levels && !config.ids) {
      return "Either levels or ids must be provided for orgUnit configuration";
    }
    return true;
  });

export const predictionSetupTriggerConfigSchema = z.object({
  backtestId: z.number().int().positive(),
  predictionSetupId: z.number().int().positive(),
  name: z.string().min(1),
  period: z.object({
    periodOffset: z.number().int().min(0).default(1),
    numberOfPeriodsToGenerate: z.number().int().positive().default(3),
  }),
});

export type PredictionSetupTriggerConfig = z.infer<typeof predictionSetupTriggerConfigSchema>;

/**
 * Legacy shape: calls POST /v1/analytics/make-prediction with a model and a covariate
 * mapping configured in CAPS. Kept so pipelines created before prediction setups keep
 * running;
 */
export const legacyPredictionTriggerConfigSchema = z.object({
  modelId: z.string(),
  name: z.string(),
  orgUnit: orgUnitSchema,
  period: z.object({
    type: z.enum([PeriodTypeEnum.WEEKLY, PeriodTypeEnum.MONTHLY]),
    periodOffset: z.number().default(0),
    numberPreviousYearsToInclude: z.number().default(2),
    numberOfPeriodsToGenerate: z.number().default(3),
  }),
  dataSources: z.array(
    z.object({
      covariate: z.string(),
      dataElementId: z.string(),
    })
  ),
});

export type LegacyPredictionTriggerConfig = z.infer<typeof legacyPredictionTriggerConfigSchema>;

export const predictionTriggerConfigSchema = z.union([
  predictionSetupTriggerConfigSchema,
  legacyPredictionTriggerConfigSchema,
]);

export type PredictionTriggerConfig = z.infer<typeof predictionTriggerConfigSchema>;

export function isLegacyPredictionTriggerConfig(
  config: PredictionTriggerConfig
): config is LegacyPredictionTriggerConfig {
  return "modelId" in config;
}

export const predictionTriggerContextSchema = z.object({
  orgUnit: orgUnitSchema.optional(),
  period: z.object({
    type: z.enum([PeriodTypeEnum.WEEKLY, PeriodTypeEnum.MONTHLY]).optional(),
    periodOffset: z.number().default(0),
    numberPreviousYearsToInclude: z.number().default(2),
    numberOfPeriodsToGenerate: z.number().default(3),
  }),
});
