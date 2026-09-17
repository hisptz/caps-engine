import { z } from "zod";
import { PeriodTypeEnum } from "@hisptz/dhis2-utils";

export const predictionTriggerConfigSchema = z.object({
  modelId: z.string(),
  name: z.string(),
  orgUnit: z
    .object({
      levels: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .refine((config) => {
      if (!config.levels && !config.ids) {
        return "Either levels or ids must be provided for orgUnit configuration";
      }
      return true;
    }),
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

export type PredictionTriggerConfig = z.infer<typeof predictionTriggerConfigSchema>;

export const predictionTriggerContextSchema = z.object({
  orgUnit: z
    .object({
      levels: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .refine((config) => {
      if (!config.levels && !config.ids) {
        return "Either levels or ids must be provided for orgUnit configuration";
      }
      return true;
    }),
  period: z.object({
    type: z.enum([PeriodTypeEnum.WEEKLY, PeriodTypeEnum.MONTHLY]),
    periodOffset: z.number().default(0),
    numberPreviousYearsToInclude: z.number().default(2),
    numberOfPeriodsToGenerate: z.number().default(3),
  }),
});
