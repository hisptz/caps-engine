import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { climateOpenEoConfigSchema } from "../climateOpenEo/schemas/config.ts";
import { getOrgUnitsGeoJSON } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import { createOpenEoJob, startOpenEoJob } from "@/shared/clients/openeo.ts";
import { rollingPeriodOf, temporalExtentFromPeriod } from "@/services/worker/utils/period.ts";
import { buildOpenEoJobBody } from "./utils/buildJob.ts";
import { partitionAreaFeatures } from "./utils/areaFeatures.ts";

export const climateOpenEoCreate: StepHandler = {
  async execute(ctx) {
    const parsed = climateOpenEoConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      await ctx.log("ERROR", `Invalid handler config: ${parsed.error.message}`);
      throw new Error("Invalid climateOpenEoCreate config");
    }
    const config = parsed.data;
    const temporalExtent = temporalExtentFromPeriod(config.period);

    await ctx.log("INFO", "Starting Open Climate Service job creation", {
      datasetId: config.datasetId,
      period: config.period,
      temporalExtent,
      rolling: rollingPeriodOf(config.period) !== null,
    });

    const orgUnitsTask = await ctx.tasks.startTask("get-org-units", {
      orgUnit: config.orgUnit,
    });
    let geometries;
    try {
      const geoJSON = await getOrgUnitsGeoJSON({ ctx, config: config.orgUnit });
      const { areas, withoutGeometry, nonArea } = partitionAreaFeatures(geoJSON.features);
      if (withoutGeometry.length > 0) {
        await ctx.log("WARN", "Skipping organisation units without geometry", {
          skippedOrgUnitIds: withoutGeometry.map((f) => f.properties.id),
          skippedCount: withoutGeometry.length,
        });
      }
      if (nonArea.length > 0) {
        await ctx.log(
          "WARN",
          "Skipping organisation units that are not areas (e.g. facility points); area-weighted aggregation needs polygons",
          {
            skippedOrgUnits: nonArea.map((f) => ({
              id: f.properties.id,
              name: f.properties.displayName,
              geometryType: f.geometry?.type,
            })),
            skippedCount: nonArea.length,
          }
        );
      }
      geometries = {
        type: "FeatureCollection" as const,
        features: areas,
      };
      await orgUnitsTask.succeed({
        featureCount: geoJSON.features.length,
        processableCount: areas.length,
        skippedCount: withoutGeometry.length + nonArea.length,
        skippedWithoutGeometryCount: withoutGeometry.length,
        skippedNonAreaCount: nonArea.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await orgUnitsTask.fail(error);
      throw error;
    }

    if (geometries.features.length === 0) {
      throw new Error(
        "No organisation units with an area (Polygon or MultiPolygon) to aggregate. " +
          "Points such as facilities cannot be area-weighted; select a level with boundaries."
      );
    }

    const jobBody = buildOpenEoJobBody({
      config,
      geometries,
      temporalExtent,
      title: `CAPS climate download ${ctx.stepExecution.id}`,
    });

    const createTask = await ctx.tasks.startTask("create-openeo-job", {
      datasetId: config.datasetId,
      featureCount: geometries.features.length,
      temporalExtent,
    });
    let jobId: string;
    try {
      const job = await createOpenEoJob(jobBody);
      jobId = job.id;
      await createTask.succeed({ jobId });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await createTask.fail(error);
      throw error;
    }

    const startTask = await ctx.tasks.startTask("start-openeo-job", { jobId });
    try {
      await startOpenEoJob(jobId);
      await startTask.succeed({ jobId });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await startTask.fail(error);
      throw error;
    }

    await ctx.log("INFO", "Open Climate Service job created and started", {
      jobId,
      temporalExtent,
    });

    return { jobId, temporalExtent };
  },
};

registerHandler(Handlers.CLIMATE_OPENEO_CREATE, climateOpenEoCreate);
