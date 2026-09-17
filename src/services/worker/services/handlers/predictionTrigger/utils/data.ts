import type { StepContext } from "@/services/worker/types/service.ts";
import type { PredictionTriggerConfig } from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import { PeriodTypeEnum } from "@hisptz/dhis2-utils";
import { DateTime, Interval } from "luxon";
import { isEmpty } from "lodash-es";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";

function generatePeriodId(interval: Interval, type: PeriodTypeEnum): string {
  switch (type) {
    case PeriodTypeEnum.MONTHLY:
      return interval.start!.toFormat("yyyyMM");
    case PeriodTypeEnum.WEEKLY:
      return interval.start!.toFormat(`yyyyW${interval.start!.weekNumber}`);
    default:
      throw new Error(`Unsupported period type: ${type}`);
  }
}

function getDurationLabel(type: PeriodTypeEnum) {
  switch (type) {
    case PeriodTypeEnum.MONTHLY:
      return "months";
    case PeriodTypeEnum.WEEKLY:
      return "weeks";
    default:
      throw Error(`Unsupported period type: ${type}`);
  }
}

/*
 * Gets the periods based on the configuration provided. It generates the periods from the last period (e.g if type is Monthly then the last month)
 * to the start date n years ago where n is the numberPreviousYearsToInclude
 *
 * input:
 * config: PredictionTriggerConfig["period"]
 * ctx: StepContext
 *
 * config contains:
 * type: PeriodTypeCategory
 * numberPreviousYearsToInclude: number
 *
 * output:
 * periods: string[]
 * */

/*
 * Gets the periods based on the configuration provided. It generates the periods from the last period (e.g if type is Monthly then the last month)
 * to the start date n years ago where n is the numberPreviousYearsToInclude
 *
 * input:
 * config: PredictionTriggerConfig["period"]
 * ctx: StepContext
 *
 * config contains:
 * type: PeriodTypeCategory
 * numberPreviousYearsToInclude: number
 *
 * output:
 * periods: string[]
 * */
async function getDatasetPeriod({
  config,
  ctx,
}: {
  config: PredictionTriggerConfig["period"];
  ctx: StepContext;
}) {
  await ctx.log("INFO", "Getting dataset period");
  const { type, numberPreviousYearsToInclude, periodOffset } = config;
  const durationLabel = getDurationLabel(type);
  const endDate = DateTime.now().minus({ [durationLabel]: periodOffset });
  const startDate = endDate.minus({ years: numberPreviousYearsToInclude });
  const interval = Interval.fromDateTimes(startDate, endDate);

  if (!interval.isValid) {
    await ctx.log("ERROR", "Invalid period configuration");
    throw new Error("Invalid period configuration");
  }

  if (interval.splitBy({ year: 1 }).length < 2) {
    await ctx.log("ERROR", "Period configuration must span at least two years");
    throw new Error("Period configuration must span at least two years");
  }

  return interval
    .splitBy({
      [durationLabel]: 1,
    })
    .map((interval) => generatePeriodId(interval, type));
}

type ProvidedData = {
  featureName: string;
  orgUnit: string;
  period: string;
  value: number;
};

export async function getDatasetForPrediction({
  config,
  ctx,
}: {
  ctx: StepContext;
  config: PredictionTriggerConfig;
}): Promise<ProvidedData[]> {
  await ctx.log("INFO", "Getting dataset to be used for the prediction");
  const periods = await getDatasetPeriod({
    ctx,
    config: config.period,
  });
  const { levels, ids } = config.orgUnit;
  const orgUnits = [...(ids ?? []), ...(levels ?? []).map((level) => `LEVEL-${level}`)];
  const params = new URLSearchParams();
  params.append("dimension", `pe:${periods.join(";")}`);
  params.append("dimension", `ou:${orgUnits.join(";")}`);
  params.append(
    "dimension",
    `dx:${config.dataSources.map(({ dataElementId }) => dataElementId).join(";")}`
  );

  const dataItemsMap = new Map<string, string>(
    config.dataSources.map(({ dataElementId, covariate }) => [dataElementId, covariate])
  );
  let response;
  try {
    response = await dhis2RestClient.get<{
      headers: Array<{
        name: string;
        column: string;
        meta: boolean;
        valueType: string;
      }>;
      rows: string[];
      metaData: {
        dimensions: string[];
        items: {
          [key: string]: {
            id: string;
            name: string;
          };
        };
      };
    }>(`analytics`, {
      params,
    });
  } catch (error) {
    await ctx.log("ERROR", "Failed to get analytics data", { error });
    throw error;
  }

  if (isEmpty(response.data.rows)) {
    await ctx.log("ERROR", "No data found for the given period and org units");
    throw new Error("No data found for the given period and org units");
  }
  const dxIndex = response.data.headers.findIndex((h) => h.name === "dx");
  const ouIndex = response.data.headers.findIndex((h) => h.name === "ou");
  const peIndex = response.data.headers.findIndex((h) => h.name === "pe");
  const valueIndex = response.data.headers.findIndex((h) => h.name === "value");

  return response.data.rows.map((row) => {
    return {
      featureName: dataItemsMap.get(row[dxIndex]!)!,
      value: parseFloat(row[valueIndex]!),
      period: row[peIndex]!,
      orgUnit: row[ouIndex]!,
    };
  });
}
