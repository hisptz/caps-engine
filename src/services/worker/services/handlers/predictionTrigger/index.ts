import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import type { MakePredictionRequest } from "@/services/worker/types/chap.ts";
import { triggerPrediction } from "@/services/worker/utils/chap.ts";
import { predictionTriggerConfigSchema } from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import { getOrgUnitsGeoJSON } from "@/services/worker/services/handlers/predictionTrigger/utils/orgUnits.ts";
import { getDatasetForPrediction } from "@/services/worker/services/handlers/predictionTrigger/utils/data.ts";

/**
 * Handler: prediction-trigger
 *
 * Submits a prediction job to CHAP via POST /analytics/make-prediction.
 *
 * Expected handlerConfig:
    @type {PredictionTriggerConfig}
 *
 * Output (passed as input to the next step):
 * { jobId: string }
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
      dataset = await getDatasetForPrediction({
        ctx,
        config,
      });
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

    let jobId: string;
    try {
      const response = await triggerPrediction(request);
      jobId = response.id;
      await task.succeed({ jobId });
    } catch (err) {
      await task.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Prediction job submitted", { jobId });

    return { jobId };
  },
};

registerHandler(Handlers.PREDICTION_TRIGGER, predictionTrigger);
