import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import type { StepContext } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import type {
  MakePredictionRequest,
  PredictionSetupRead,
  RunPredictionSetupRequest,
} from "@/services/worker/types/chap.ts";
import {
  getPredictionSetup,
  runPredictionSetup,
  triggerPrediction,
} from "@/services/worker/utils/chap.ts";
import {
  isLegacyPredictionTriggerConfig,
  predictionTriggerConfigSchema,
  type LegacyPredictionTriggerConfig,
  type PredictionSetupTriggerConfig,
} from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import { getOrgUnitsGeoJSON } from "@/services/worker/services/handlers/predictionTrigger/utils/orgUnits.ts";
import {
  getDatasetForPrediction,
  getDatasetForPredictionSetup,
} from "@/services/worker/services/handlers/predictionTrigger/utils/data.ts";

/**
 * Handler: prediction-trigger
 *
 * Runs a CHAP prediction setup (POST /v1/crud/prediction-setups/{id}/run) with observations
 * fetched from DHIS2 analytics. The setup carries the model, org units, covariate sources and
 * period type copied from the evaluation it was promoted from, so CAPS only chooses the run
 * name and how far back the training window ends.
 *
 * Pipelines configured before prediction setups existed still carry a `modelId` and their own
 * covariate mapping; those fall back to POST /v1/analytics/make-prediction.
 *
 * Output (passed as input to the next step):
 * { jobId: string; predictionSetupId: number | null }
 */
export const predictionTrigger: StepHandler = {
  async execute(ctx) {
    await ctx.log("INFO", "Parsing prediction trigger config");
    const configParse = predictionTriggerConfigSchema.safeParse(ctx.handlerConfig);

    if (!configParse.success) {
      await ctx.log("ERROR", configParse.error.message);
      throw configParse.error;
    }
    await ctx.log("INFO", "Parsed prediction trigger config");
    const config = configParse.data;

    const legacy = isLegacyPredictionTriggerConfig(config);
    const jobId = legacy
      ? await runLegacyPrediction({ ctx, config })
      : await runSetupPrediction({ ctx, config });

    await ctx.log("INFO", "Prediction job submitted", { jobId });
    return { jobId, predictionSetupId: legacy ? null : config.predictionSetupId };
  },
};

async function runSetupPrediction({
  ctx,
  config,
}: {
  ctx: StepContext;
  config: PredictionSetupTriggerConfig;
}): Promise<string> {
  //Task 1: Read the setup this step runs
  await ctx.log("INFO", "Fetching prediction setup from CHAP", {
    predictionSetupId: config.predictionSetupId,
  });
  const setupTask = await ctx.tasks.startTask("get-prediction-setup");
  let setup: PredictionSetupRead;
  try {
    setup = await getPredictionSetup(config.predictionSetupId);
    await setupTask.succeed({
      name: setup.name,
      periodType: setup.periodType,
      orgUnitCount: setup.orgUnits.length,
      covariates: setup.covariateSources.map(({ covariate }) => covariate),
    });
  } catch (error) {
    await setupTask.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  //Task 2: Get the geoJSON of the setup's organisation units
  await ctx.log("INFO", "Getting geoJSON of organisation units");
  const geoJSONTask = await ctx.tasks.startTask("get-geoJSON");
  let geoJSON;
  try {
    geoJSON = await getOrgUnitsGeoJSON({ ctx, config: { ids: setup.orgUnits } });
    await ctx.log("INFO", "GeoJSON of organisation units retrieved");
    await geoJSONTask.succeed({ geoJSON });
  } catch (error) {
    await geoJSONTask.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  //Task 3: Get the observations for the setup's covariate sources
  const datasetTask = await ctx.tasks.startTask("get-dataset");
  let observations;
  try {
    const dataset = await getDatasetForPredictionSetup({
      ctx,
      setup,
      periodOffset: config.period.periodOffset,
    });
    observations = dataset.observations;
    await warnOnIncompleteCoverage({ ctx, setup, observations });
    await datasetTask.succeed({ dataset: observations });
  } catch (error) {
    await datasetTask.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  const request: RunPredictionSetupRequest = {
    name: config.name,
    geojson: geoJSON as RunPredictionSetupRequest["geojson"],
    providedData: observations,
    nPeriods: config.period.numberOfPeriodsToGenerate,
  };

  await ctx.log("INFO", "Running prediction setup in CHAP", {
    predictionSetupId: config.predictionSetupId,
    name: request.name,
    nPeriods: request.nPeriods,
  });

  //Task 4: Run the setup
  const task = await ctx.tasks.startTask("submit-prediction", {
    request: { ...request, providedData: `${observations.length} observations` },
  });
  try {
    const response = await runPredictionSetup(config.predictionSetupId, request);
    await task.succeed({ jobId: response.id });
    return response.id;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

async function warnOnIncompleteCoverage({
  ctx,
  setup,
  observations,
}: {
  ctx: StepContext;
  setup: PredictionSetupRead;
  observations: Array<{ orgUnit: string; featureName: string }>;
}): Promise<void> {
  const covariates = setup.covariateSources.map(({ covariate }) => covariate);
  const seen = new Map<string, Set<string>>();
  for (const { orgUnit, featureName } of observations) {
    const features = seen.get(orgUnit) ?? new Set<string>();
    features.add(featureName);
    seen.set(orgUnit, features);
  }

  const incomplete = setup.orgUnits.filter((orgUnit) => {
    const features = seen.get(orgUnit);
    return !features || covariates.some((covariate) => !features.has(covariate));
  });

  if (incomplete.length > 0) {
    await ctx.log(
      "WARN",
      `${incomplete.length} of ${setup.orgUnits.length} org units are missing covariate data and will be dropped by CHAP`,
      { orgUnits: incomplete.slice(0, 20) }
    );
  }
}

async function runLegacyPrediction({
  ctx,
  config,
}: {
  ctx: StepContext;
  config: LegacyPredictionTriggerConfig;
}): Promise<string> {
  await ctx.log(
    "WARN",
    "This step still uses a model and covariate mapping configured in CAPS. Re-configure it against a CHAP evaluation and prediction setup."
  );

  //Task 1: Get the geoJSON of the defined organisation units
  let geoJSON;
  await ctx.log("INFO", "Getting geoJSON of organisation units");
  const geoJSONTask = await ctx.tasks.startTask("get-geoJSON");
  try {
    geoJSON = await getOrgUnitsGeoJSON({ ctx, config: config.orgUnit });
    await ctx.log("INFO", "GeoJSON of organisation units retrieved");
    await geoJSONTask.succeed({ geoJSON });
  } catch (error) {
    await geoJSONTask.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  let dataset;
  //Task2: Get the dataset to be used for the prediction
  await ctx.log("INFO", "Getting dataset to be used for the prediction");
  const datasetTask = await ctx.tasks.startTask("get-dataset");
  try {
    dataset = await getDatasetForPrediction({ ctx, config });
    await datasetTask.succeed({ dataset });
  } catch (error) {
    await datasetTask.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  const request: MakePredictionRequest = {
    type: "forecasting",
    modelId: config.modelId,
    name: config.name,
    geojson: geoJSON as MakePredictionRequest["geojson"],
    providedData: dataset,
    dataToBeFetched: [],
    nPeriods: config.period.numberOfPeriodsToGenerate ?? 3,
    metaData: {},
    ...(config.dataSources != null && { dataSources: config.dataSources }),
  };

  await ctx.log("INFO", "Submitting prediction job to CHAP", {
    modelId: request.modelId,
    name: request.name,
    nPeriods: request.nPeriods,
  });

  //Task 3: Send the prediction request
  const task = await ctx.tasks.startTask("submit-prediction", { request });
  try {
    const response = await triggerPrediction(request);
    await task.succeed({ jobId: response.id });
    return response.id;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

registerHandler(Handlers.PREDICTION_TRIGGER, predictionTrigger);
