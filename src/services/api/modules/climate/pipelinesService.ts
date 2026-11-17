import { handleClimateRequest } from "@/services/api/utils/climate/errors.ts";
import {
  createOcsPipeline,
  dryRunOcsPipeline,
  getOcsPipeline,
  intervalParameters,
  isPipelineReady,
  listOcsDatasets,
  listOcsFeatureCollections,
  listOcsPipelines,
  listOcsWorkflows,
  parameterSchema,
  setOcsPipelineMode,
  updateOcsPipeline,
  type OcsDeliveryMode,
  type OcsDryRun,
  type OcsPipeline,
} from "@/shared/clients/ocsPipelines.ts";
import { env } from "@/shared/utils";
import type {
  OcsPipelineChangeBody,
  OcsPipelineCreateBody,
  OcsPipelineIntervalBody,
} from "@/services/api/modules/climate/model.ts";

export type OcsPipelineOptions = {
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
  collections: Array<{ id: string; name: string; featureCount?: number | null }>;
  /** Named DHIS2 connections: OCS_DHIS2_CONNECTIONS plus any an existing pipeline uses. */
  connections: string[];
};

function configuredConnections(): string[] {
  return env.OCS_DHIS2_CONNECTIONS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function connectionOf(pipeline: OcsPipeline): string | null {
  const connection = pipeline.spec.destination.settings.connection;
  return typeof connection === "string" && connection ? connection : null;
}

/**
 * CAPS decides when an OCS pipeline it runs starts, so every pipeline saved from here is
 * `manual`: OCS starting it on a dataset update as well would deliver the same values twice.
 */
function asManual<T extends { delivery?: { mode?: OcsDeliveryMode } }>(body: T) {
  return {
    ...body,
    delivery: { mode: body.delivery?.mode ?? "dry_run", policy: "manual" as const },
  };
}

export class OcsPipelinesService {
  list(): Promise<{ items: OcsPipeline[] }> {
    return handleClimateRequest(async () => ({ items: await listOcsPipelines() }));
  }

  get(pipelineId: string): Promise<OcsPipeline> {
    return handleClimateRequest(() => getOcsPipeline(pipelineId), {
      notFoundDetails: { pipelineId },
    });
  }

  create(body: OcsPipelineCreateBody): Promise<OcsPipeline> {
    return handleClimateRequest(() =>
      createOcsPipeline(asManual({ ...body, name: body.name ?? null }))
    );
  }

  update(pipelineId: string, body: OcsPipelineChangeBody): Promise<OcsPipeline> {
    return handleClimateRequest(
      () => updateOcsPipeline(pipelineId, asManual({ ...body, name: body.name ?? null })),
      { notFoundDetails: { pipelineId } }
    );
  }

  dryRun(pipelineId: string, interval: OcsPipelineIntervalBody): Promise<OcsDryRun> {
    return handleClimateRequest(() => dryRunOcsPipeline(pipelineId, interval), {
      notFoundDetails: { pipelineId },
    });
  }

  setMode(pipelineId: string, mode: OcsDeliveryMode): Promise<OcsPipeline> {
    return handleClimateRequest(() => setOcsPipelineMode(pipelineId, mode), {
      notFoundDetails: { pipelineId },
    });
  }

  /** What the setup form offers, as OCS's own create page does (it has no JSON for this). */
  options(): Promise<OcsPipelineOptions> {
    return handleClimateRequest(async () => {
      const [workflows, datasets, collections, pipelines] = await Promise.all([
        listOcsWorkflows(),
        listOcsDatasets(),
        listOcsFeatureCollections(),
        listOcsPipelines().catch(() => [] as OcsPipeline[]),
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
        })),
        connections: [...connections].sort(),
      };
    });
  }
}
