import { handleClimateRequest } from "@/services/api/utils/climate/errors.ts";
import {
  createGeoservicePipeline,
  dryRunGeoservicePipeline,
  getGeoservicePipeline,
  intervalParameters,
  isPipelineReady,
  listGeoserviceDatasets,
  listGeoserviceFeatureCollections,
  listGeoservicePipelines,
  listGeoserviceWorkflows,
  parameterSchema,
  setGeoservicePipelineMode,
  updateGeoservicePipeline,
  type GeoserviceDeliveryMode,
  type GeoserviceDryRun,
  type GeoservicePipeline,
} from "@/shared/clients/geoservicePipelines.ts";
import { env } from "@/shared/utils";
import type {
  GeoservicePipelineChangeBody,
  GeoservicePipelineCreateBody,
  GeoservicePipelineIntervalBody,
} from "@/services/api/modules/climate/model.ts";

export type GeoservicePipelineOptions = {
  workflows: Array<{
    id: string;
    summary: string;
    description?: string | null;
    /** The parameters a pipeline binds; the interval parameter is filled by each run. */
    parameters: Array<{
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      default?: unknown;
      required: boolean;
    }>;
    intervalParameters: string[];
  }>;
  datasets: Array<{ id: string; name: string; variable?: string; periodType?: string }>;
  collections: Array<{
    id: string;
    name: string;
    featureCount?: number | null;
    /** As geoservice stored them; zonal aggregation takes only Polygon and MultiPolygon. */
    geometryTypes: string[];
  }>;
  /** Named DHIS2 connections: GEOSERVICE_DHIS2_CONNECTIONS plus any an existing pipeline uses. */
  connections: string[];
};

export function configuredConnections(
  source: Pick<typeof env, "GEOSERVICE_DHIS2_CONNECTIONS"> = env
): string[] {
  return source.GEOSERVICE_DHIS2_CONNECTIONS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function connectionOf(pipeline: GeoservicePipeline): string | null {
  const connection = pipeline.spec.destination.settings.connection;
  return typeof connection === "string" && connection ? connection : null;
}

/**
 * CAPS decides when an geoservice pipeline it runs starts, so every pipeline saved from here is
 * `manual`: geoservice starting it on a dataset update as well would deliver the same values twice.
 */
function asManual<T extends { delivery?: { mode?: GeoserviceDeliveryMode } }>(body: T) {
  return {
    ...body,
    delivery: { mode: body.delivery?.mode ?? "dry_run", policy: "manual" as const },
  };
}

export class GeoservicePipelinesService {
  list(): Promise<{ items: GeoservicePipeline[] }> {
    return handleClimateRequest(async () => ({ items: await listGeoservicePipelines() }));
  }

  get(pipelineId: string): Promise<GeoservicePipeline> {
    return handleClimateRequest(() => getGeoservicePipeline(pipelineId), {
      notFoundDetails: { pipelineId },
    });
  }

  create(body: GeoservicePipelineCreateBody): Promise<GeoservicePipeline> {
    return handleClimateRequest(() =>
      createGeoservicePipeline(asManual({ ...body, name: body.name ?? null }))
    );
  }

  update(pipelineId: string, body: GeoservicePipelineChangeBody): Promise<GeoservicePipeline> {
    return handleClimateRequest(
      () => updateGeoservicePipeline(pipelineId, asManual({ ...body, name: body.name ?? null })),
      { notFoundDetails: { pipelineId } }
    );
  }

  dryRun(pipelineId: string, interval: GeoservicePipelineIntervalBody): Promise<GeoserviceDryRun> {
    return handleClimateRequest(() => dryRunGeoservicePipeline(pipelineId, interval), {
      notFoundDetails: { pipelineId },
    });
  }

  setMode(pipelineId: string, mode: GeoserviceDeliveryMode): Promise<GeoservicePipeline> {
    return handleClimateRequest(() => setGeoservicePipelineMode(pipelineId, mode), {
      notFoundDetails: { pipelineId },
    });
  }

  /** What the setup form offers, as geoservice's own create page does (it has no JSON for this). */
  options(): Promise<GeoservicePipelineOptions> {
    return handleClimateRequest(async () => {
      const [workflows, datasets, collections, pipelines] = await Promise.all([
        listGeoserviceWorkflows(),
        listGeoserviceDatasets(),
        listGeoserviceFeatureCollections(),
        listGeoservicePipelines().catch(() => [] as GeoservicePipeline[]),
      ]);
      const connections = new Set(configuredConnections());
      for (const pipeline of pipelines) {
        const connection = connectionOf(pipeline);
        if (connection) connections.add(connection);
      }
      return {
        workflows: workflows.filter(isPipelineReady).map((workflow) => {
          const interval = intervalParameters(workflow);
          return {
            id: workflow.id,
            summary: workflow.summary || workflow.id,
            description: workflow.description,
            parameters: workflow.parameters
              .filter((p) => typeof p.name === "string" && !interval.includes(p.name))
              .map((p) => ({
                name: p.name,
                description: p.description,
                schema: parameterSchema(p),
                default: p.default,
                required: !("default" in p) && !p.optional,
              })),
            intervalParameters: interval,
          };
        }),
        datasets: datasets
          .filter((item) => (item.itemType ?? item.item_type ?? "coverage") === "coverage")
          .map((item) => ({
            id: String(item.dataset_id),
            name: String(item.dataset_name ?? item.dataset_id),
            variable: typeof item.variable === "string" ? item.variable : undefined,
            periodType: typeof item.period_type === "string" ? item.period_type : undefined,
          })),
        collections: collections.map((item) => ({
          id: item.id,
          name: item.name || item.id,
          featureCount: item.feature_count,
          geometryTypes: item.geometry_types ?? [],
        })),
        connections: [...connections].sort(),
      };
    });
  }
}
