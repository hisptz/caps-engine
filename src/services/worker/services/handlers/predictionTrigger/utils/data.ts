import type { StepContext } from "@/services/worker/types/service.ts";
import type { LegacyPredictionTriggerConfig } from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import type { PredictionSetupRead } from "@/services/worker/types/chap.ts";
import { PeriodTypeEnum } from "@hisptz/dhis2-utils";
import { DateTime, Interval } from "luxon";
import { isEmpty } from "lodash-es";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";

function generatePeriodId(interval: Interval, type: PeriodTypeEnum): string {
  switch (type) {
    case PeriodTypeEnum.MONTHLY:
      return interval.start!.toFormat("yyyyMM");
    case PeriodTypeEnum.WEEKLY:
      return `${interval.start!.weekYear}W${interval.start!.weekNumber}`;
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
  config: LegacyPredictionTriggerConfig["period"];
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

type CovariateSource = { covariate: string; dataElementId: string };

/**
 * Pulls one analytics table for the given periods, org units and covariate sources, and
 * flattens it into the `providedData` observations CHAP expects.
 */
async function fetchObservations({
  ctx,
  periods,
  orgUnits,
  dataSources,
}: {
  ctx: StepContext;
  periods: string[];
  orgUnits: string[];
  dataSources: CovariateSource[];
}): Promise<ProvidedData[]> {
  const params = new URLSearchParams();
  params.append("dimension", `pe:${periods.join(";")}`);
  params.append("dimension", `ou:${orgUnits.join(";")}`);
  params.append(
    "dimension",
    `dx:${dataSources.map(({ dataElementId }) => dataElementId).join(";")}`
  );

  const dataItemsMap = new Map<string, string>(
    dataSources.map(({ dataElementId, covariate }) => [dataElementId, covariate])
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

export async function getDatasetForPrediction({
  config,
  ctx,
}: {
  ctx: StepContext;
  config: LegacyPredictionTriggerConfig;
}): Promise<ProvidedData[]> {
  await ctx.log("INFO", "Getting dataset to be used for the prediction");
  const periods = await getDatasetPeriod({ ctx, config: config.period });
  const { levels, ids } = config.orgUnit;
  const orgUnits = [...(ids ?? []), ...(levels ?? []).map((level) => `LEVEL-${level}`)];
  return fetchObservations({ ctx, periods, orgUnits, dataSources: config.dataSources });
}

export function toPeriodType(periodType: string | null | undefined): PeriodTypeEnum {
  switch (periodType?.toLowerCase()) {
    case "month":
    case "monthly":
      return PeriodTypeEnum.MONTHLY;
    case "week":
    case "weekly":
      return PeriodTypeEnum.WEEKLY;
    default:
      throw new Error(
        `Unsupported period type "${periodType}" on the prediction setup; CAPS supports month and week.`
      );
  }
}

function parsePeriodId(periodId: string, type: PeriodTypeEnum): DateTime {
  if (type === PeriodTypeEnum.MONTHLY) {
    const parsed = DateTime.fromFormat(periodId, "yyyyMM");
    if (!parsed.isValid) {
      throw new Error(`Could not read the setup's start period "${periodId}" as a monthly period`);
    }
    return parsed.startOf("month");
  }
  const match = /^(\d{4})W(\d{1,2})$/.exec(periodId);
  if (!match) {
    throw new Error(`Could not read the setup's start period "${periodId}" as a weekly period`);
  }
  const parsed = DateTime.fromObject({
    weekYear: Number(match[1]),
    weekNumber: Number(match[2]),
  });
  if (!parsed.isValid) {
    throw new Error(`Could not read the setup's start period "${periodId}" as a weekly period`);
  }
  return parsed.startOf("week");
}

/**
 * Builds the training window: every period from the setup's `startPeriod` up to
 * `periodOffset` periods back from today. Offset 0 ends on the current (incomplete)
 * period, 1 ends on the previous one.
 */
export function getTrainingPeriods({
  startPeriod,
  periodType,
  periodOffset,
  now = DateTime.now(),
}: {
  startPeriod: string;
  periodType: PeriodTypeEnum;
  periodOffset: number;
  now?: DateTime;
}): string[] {
  const durationLabel = getDurationLabel(periodType);
  const unit = periodType === PeriodTypeEnum.MONTHLY ? "month" : "week";
  const start = parsePeriodId(startPeriod, periodType);
  const end = now.minus({ [durationLabel]: periodOffset }).startOf(unit);

  if (end < start) {
    throw new Error(
      `Training period ends before the setup's start period (${startPeriod}); lower the period offset.`
    );
  }

  const interval = Interval.fromDateTimes(start, end.plus({ [durationLabel]: 1 }));
  if (!interval.isValid) {
    throw new Error("Invalid training period configuration");
  }
  return interval
    .splitBy({ [durationLabel]: 1 })
    .map((slice) => generatePeriodId(slice, periodType));
}

/**
 * Fetches the observations a prediction setup run needs. Org units, covariate sources and
 * period type all come from the setup, so they stay identical to what the model was
 * evaluated on; only the end of the training window is configured in CAPS.
 */
export async function getDatasetForPredictionSetup({
  ctx,
  setup,
  periodOffset,
}: {
  ctx: StepContext;
  setup: PredictionSetupRead;
  periodOffset: number;
}): Promise<{ observations: ProvidedData[]; periods: string[] }> {
  await ctx.log("INFO", "Getting dataset to be used for the prediction");

  if (!setup.startPeriod) {
    throw new Error(
      `Prediction setup "${setup.name}" has no start period; re-create it from an evaluation whose dataset has one.`
    );
  }
  if (isEmpty(setup.covariateSources)) {
    throw new Error(
      `Prediction setup "${setup.name}" has no covariate sources, so CAPS cannot fetch its inputs from DHIS2.`
    );
  }
  if (isEmpty(setup.orgUnits)) {
    throw new Error(`Prediction setup "${setup.name}" has no org units.`);
  }

  const periodType = toPeriodType(setup.periodType);
  const periods = getTrainingPeriods({
    startPeriod: setup.startPeriod,
    periodType,
    periodOffset,
  });

  await ctx.log("INFO", "Resolved training period from the prediction setup", {
    startPeriod: setup.startPeriod,
    endPeriod: periods.at(-1),
    periodCount: periods.length,
  });

  const observations = await fetchObservations({
    ctx,
    periods,
    orgUnits: setup.orgUnits,
    dataSources: setup.covariateSources,
  });

  return { observations, periods };
}
