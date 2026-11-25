import { climateApiClient } from "@/shared/clients/climateApi.ts";

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/** The id rule geoservice holds pipeline (and export) ids to. */
export const GEOSERVICE_PIPELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type GeoserviceDeliveryMode = "dry_run" | "live" | "paused";
export type GeoserviceDeliveryPolicy = "on_update" | "manual";
export type GeoserviceRunMode = "dry_run" | "live";

export type GeoservicePipelineDefinition = {
  name?: string | null;
  workflow: { id: string; arguments: Record<string, unknown> };
  destination: { plugin: string; settings: Record<string, unknown> };
  delivery: { mode: GeoserviceDeliveryMode; policy: GeoserviceDeliveryPolicy };
};

export type GeoservicePipelineSpec = GeoservicePipelineDefinition & { id: string };

export type GeoserviceValidation = {
  valid: boolean;
  checked_at: string;
  checks: Array<{ id: string; status: "pass" | "fail" | "skip"; message: string }>;
};

/** Run states; `succeeded`, `needs_attention`, `failed` and `canceled` are final. */
export type GeoserviceRunStatus =
  | "submitting"
  | "queued"
  | "running"
  | "delivering"
  | "held"
  | "succeeded"
  | "needs_attention"
  | "failed"
  | "canceled";

export const FINAL_GEOSERVICE_RUN_STATUSES: ReadonlySet<GeoserviceRunStatus> = new Set([
  "succeeded",
  "needs_attention",
  "failed",
  "canceled",
]);

export type GeoservicePipelineRun = {
  run_id: string;
  status: GeoserviceRunStatus;
  failure?: { stage: "submission" | "job" | "delivery"; message: string } | null;
  mode: GeoserviceRunMode;
  start: string;
  end: string;
  job_status?: string;
  delivery?: string;
  delivery_result?: string | null;
  delivery_submitted?: number | null;
  delivery_conflicts?: number | null;
  error?: string | null;
  links?: { self: string; job?: string | null; delivery?: string | null };
};

/** A dry run: what was rendered and the destination's verdict on it. */
export type GeoserviceDryRun = {
  ran_at: string;
  start: string;
  end: string;
  values: number;
  periods: string[];
  sample?: Array<Record<string, unknown>>;
  report?: Record<string, unknown> | null;
  rendered_only?: boolean;
  error?: string | null;
};

export type GeoservicePipeline = {
  spec: GeoservicePipelineSpec;
  revision: number;
  created_at: string;
  updated_at?: string | null;
  /** Whether the current bindings passed a dry run, which going live needs. */
  approved: boolean;
  validation?: GeoserviceValidation | null;
  dry_run?: GeoserviceDryRun | null;
  trigger: { policy: GeoserviceDeliveryPolicy; datasets: string[] };
  inputs: Array<{ kind: "dataset" | "features"; id: string; name: string; parameter: string }>;
  workflow: { id: string; title: string; arguments: Record<string, unknown> };
  destination: {
    plugin: string;
    title: string;
    settings: Array<{ name: string; title: string; value?: unknown; label?: string | null }>;
  };
  latest_run?: GeoservicePipelineRun | null;
};

export type GeoserviceWorkflowParameter = {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  default?: unknown;
  optional?: boolean;
};

export type GeoserviceWorkflow = {
  id: string;
  summary?: string | null;
  description?: string | null;
  parameters: GeoserviceWorkflowParameter[];
  process_graph: Record<string, unknown>;
};

const path = (pipelineId: string) => `/pipelines/${encodeURIComponent(pipelineId)}`;

export async function listGeoservicePipelines(): Promise<GeoservicePipeline[]> {
  const { data } = await climateApiClient.get<{ items: GeoservicePipeline[] }>("/pipelines", {
    headers: JSON_HEADERS,
  });
  return data.items ?? [];
}

export async function getGeoservicePipeline(pipelineId: string): Promise<GeoservicePipeline> {
  const { data } = await climateApiClient.get<GeoservicePipeline>(path(pipelineId), {
    headers: JSON_HEADERS,
  });
  return data;
}

/** Validated by geoservice first: a failing check is refused with 422 and the checks under `detail`. */
export async function createGeoservicePipeline(
  spec: GeoservicePipelineSpec
): Promise<GeoservicePipeline> {
  const { data } = await climateApiClient.post<GeoservicePipeline>("/pipelines", spec, {
    headers: JSON_HEADERS,
  });
  return data;
}

/** `revision` is the one the change was based on; a stale one is refused with 409. */
export async function updateGeoservicePipeline(
  pipelineId: string,
  change: GeoservicePipelineDefinition & { revision: number }
): Promise<GeoservicePipeline> {
  const { data } = await climateApiClient.put<GeoservicePipeline>(path(pipelineId), change, {
    headers: JSON_HEADERS,
  });
  return data;
}

/** Renders one interval and has the destination judge it without writing; going live needs a passed one. */
export async function dryRunGeoservicePipeline(
  pipelineId: string,
  interval: { start: string; end: string }
): Promise<GeoserviceDryRun> {
  const { data } = await climateApiClient.post<GeoserviceDryRun>(
    `${path(pipelineId)}/dry-run`,
    interval,
    {
      headers: JSON_HEADERS,
    }
  );
  return data;
}

export async function setGeoservicePipelineMode(
  pipelineId: string,
  mode: GeoserviceDeliveryMode
): Promise<GeoservicePipeline> {
  const { data } = await climateApiClient.post<GeoservicePipeline>(
    `${path(pipelineId)}/mode/${mode}`,
    {},
    { headers: JSON_HEADERS }
  );
  return data;
}

/** Starts one run over an explicit interval; geoservice answers 202 with the run to poll. */
export async function startGeoservicePipelineRun(
  pipelineId: string,
  request: { start: string; end: string; mode: GeoserviceRunMode }
): Promise<GeoservicePipelineRun> {
  const { data } = await climateApiClient.post<GeoservicePipelineRun>(
    `${path(pipelineId)}/runs`,
    request,
    {
      headers: JSON_HEADERS,
    }
  );
  return data;
}

export async function getGeoservicePipelineRun(
  pipelineId: string,
  runId: string
): Promise<GeoservicePipelineRun> {
  const { data } = await climateApiClient.get<GeoservicePipelineRun>(
    `${path(pipelineId)}/runs/${encodeURIComponent(runId)}`,
    { headers: JSON_HEADERS }
  );
  return data;
}

export async function listGeoserviceWorkflows(): Promise<GeoserviceWorkflow[]> {
  const { data } = await climateApiClient.get<{ processes?: GeoserviceWorkflow[] }>(
    "/process_graphs",
    {
      headers: JSON_HEADERS,
    }
  );
  return data.processes ?? [];
}

export async function listGeoserviceFeatureCollections(): Promise<
  Array<{
    id: string;
    name?: string | null;
    feature_count?: number | null;
    geometry_types?: string[] | null;
  }>
> {
  const { data } = await climateApiClient.get<{
    items?: Array<{
      id: string;
      name?: string | null;
      feature_count?: number | null;
      geometry_types?: string[] | null;
    }>;
  }>("/features", { headers: JSON_HEADERS });
  return data.items ?? [];
}

export async function listGeoserviceDatasets(): Promise<Array<Record<string, unknown>>> {
  const { data } = await climateApiClient.get<{ items?: Array<Record<string, unknown>> }>(
    "/datasets",
    {
      headers: JSON_HEADERS,
    }
  );
  return data.items ?? [];
}

/**
 * A dataset's period type (`daily`, `monthly`, ...) as geoservice lists it, or null when geoservice does not
 * list the dataset. A pipeline delivers values at this period type: geoservice does not resample in time.
 */
export async function getGeoserviceDatasetPeriodType(datasetId: string): Promise<string | null> {
  const item = (await listGeoserviceDatasets()).find((dataset) => dataset.dataset_id === datasetId);
  return typeof item?.period_type === "string" ? item.period_type.toLowerCase() : null;
}

// --- workflow parameters, as geoservice reads them (open_geo_service/pipelines/workflow.py) ---

const TEMPORAL_INTERVAL = "temporal-interval";

export function parameterSchema(parameter: GeoserviceWorkflowParameter): Record<string, unknown> {
  return parameter.schema && typeof parameter.schema === "object" ? parameter.schema : {};
}

/** The parameters each run fills with its own interval; a pipeline never binds them. */
export function intervalParameters(workflow: GeoserviceWorkflow): string[] {
  return workflow.parameters
    .filter((p) => typeof p.name === "string" && parameterSchema(p).subtype === TEMPORAL_INTERVAL)
    .map((p) => p.name);
}

/** Whether a pipeline can run the workflow: it takes an interval and does not save its own result. */
export function isPipelineReady(workflow: GeoserviceWorkflow): boolean {
  const nodes = Object.values(workflow.process_graph ?? {});
  const savesOwnResult = nodes.some(
    (node) =>
      typeof node === "object" &&
      node !== null &&
      (node as { result?: boolean }).result &&
      (node as { process_id?: string }).process_id === "save_result"
  );
  return nodes.length > 0 && intervalParameters(workflow).length > 0 && !savesOwnResult;
}
