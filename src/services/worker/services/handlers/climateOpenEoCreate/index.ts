import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { climateOpenEoConfigSchema } from "../climateOpenEo/schemas/config.ts";
import type { OrgUnitFeature } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import { getOrgUnitsGeoJSON } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import type { GeoJsonGeometry } from "@/services/worker/types/geojson.ts";
import { createOpenEoJob, startOpenEoJob } from "@/shared/clients/openeo.ts";
import { buildOpenEoJobBody } from "./utils/buildJob.ts";

function featuresWithGeometry(
  features: OrgUnitFeature[]
): Array<OrgUnitFeature & { geometry: GeoJsonGeometry }> {
  return features.filter(
    (f): f is OrgUnitFeature & { geometry: GeoJsonGeometry } => f.geometry != null
  );
}

export const climateOpenEoCreate: StepHandler = {
  async execute(ctx) {
    const parsed = climateOpenEoConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      await ctx.log("ERROR", `Invalid handler config: ${parsed.error.message}`);
      throw new Error("Invalid climateOpenEoCreate config");
    }
    const config = parsed.data;

    await ctx.log("INFO", "Starting Open Climate Service job creation", {
      datasetId: config.datasetId,
      period: config.period,
    });

    const orgUnitsTask = await ctx.tasks.startTask("get-org-units", {
      orgUnit: config.orgUnit,
    });
    let geometries;
    try {
      const geoJSON = await getOrgUnitsGeoJSON({ ctx, config: config.orgUnit });
      const skipped = geoJSON.features.filter((f) => !f.geometry);
      if (skipped.length > 0) {
        await ctx.log("WARN", "Skipping organisation units without geometry", {
          skippedOrgUnitIds: skipped.map((f) => f.properties.id),
          skippedCount: skipped.length,
        });
      }
      const processable = featuresWithGeometry(geoJSON.features);
      geometries = {
        type: "FeatureCollection" as const,
        features: processable,
      };
      await orgUnitsTask.succeed({
        featureCount: geoJSON.features.length,
        processableCount: processable.length,
        skippedCount: skipped.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await orgUnitsTask.fail(error);
      throw error;
    }

    if (geometries.features.length === 0) {
      throw new Error(
        "No organisation units with geometry available for Open Climate Service aggregation"
      );
    }

    const jobBody = buildOpenEoJobBody({
      config,
      geometries,
      title: `CAPS climate download ${ctx.stepExecution.id}`,
    });

    const createTask = await ctx.tasks.startTask("create-openeo-job", {
      datasetId: config.datasetId,
      featureCount: geometries.features.length,
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

    await ctx.log("INFO", "Open Climate Service job created and started", { jobId });

    return { jobId };
  },
};

registerHandler(Handlers.CLIMATE_OPENEO_CREATE, climateOpenEoCreate);
