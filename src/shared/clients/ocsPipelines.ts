import { climateApiClient } from "@/shared/clients/climateApi.ts";

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/** The id rule OCS holds pipeline (and export) ids to. */
export const OCS_PIPELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type OcsDeliveryMode = "dry_run" | "live" | "paused";
export type OcsDeliveryPolicy = "on_update" | "manual";
export type OcsRunMode = "dry_run" | "live";

export type OcsPipelineDefinition = {
  name?: string | null;
  workflow: { id: string; arguments: Record<string, unknown> };
  destination: { plugin: string; settings: Record<string, unknown> };
  delivery: { mode: OcsDeliveryMode; policy: OcsDeliveryPolicy };
};

export type OcsPipelineSpec = OcsPipelineDefinition & { id: string };

export type OcsValidation = {
  valid: boolean;
  checked_at: string;
  checks: Array<{ id: string; status: "pass" | "fail" | "skip"; message: string }>;
};

/** Run states; `succeeded`, `needs_attention`, `failed` and `canceled` are final. */
export type OcsRunStatus =
  | "submitting"
  | "queued"
  | "running"
  | "delivering"
  | "held"
  | "succeeded"
  | "needs_attention"
  | "failed"
  | "canceled";

export const FINAL_OCS_RUN_STATUSES: ReadonlySet<OcsRunStatus> = new Set([
  "succeeded",
  "needs_attention",
  "failed",
  "canceled",
]);

export type OcsPipelineRun = {
  run_id: string;
  status: OcsRunStatus;
  failure?: { stage: "submission" | "job" | "delivery"; message: string } | null;
  mode: OcsRunMode;
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
export type OcsDryRun = {
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

export type OcsPipeline = {
  spec: OcsPipelineSpec;
  revision: number;
  created_at: string;
  updated_at?: string | null;
  /** Whether the current bindings passed a dry run, which going live needs. */
  approved: boolean;
  validation?: OcsValidation | null;
  dry_run?: OcsDryRun | null;
  trigger: { policy: OcsDeliveryPolicy; datasets: string[] };
  inputs: Array<{ kind: "dataset" | "features"; id: string; name: string; parameter: string }>;
  workflow: { id: string; title: string; arguments: Record<string, unknown> };
  destination: {
    plugin: string;
    title: string;
    settings: Array<{ name: string; title: string; value?: unknown; label?: string | null }>;
  };
  latest_run?: OcsPipelineRun | null;
};

export type OcsWorkflowParameter = {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  default?: unknown;
  optional?: boolean;
};

export type OcsWorkflow = {
  id: string;
  summary?: string | null;
  description?: string | null;
  parameters: OcsWorkflowParameter[];
  process_graph: Record<string, unknown>;
};

const path = (pipelineId: string) => `/pipelines/${encodeURIComponent(pipelineId)}`;

export async function listOcsPipelines(): Promise<OcsPipeline[]> {
  const { data } = await climateApiClient.get<{ items: OcsPipeline[] }>("/pipelines", {
    headers: JSON_HEADERS,
  });
  return data.items ?? [];
}

export async function getOcsPipeline(pipelineId: string): Promise<OcsPipeline> {
  const { data } = await climateApiClient.get<OcsPipeline>(path(pipelineId), {
    headers: JSON_HEADERS,
  });
  return data;
}

/** Validated by OCS first: a failing check is refused with 422 and the checks under `detail`. */
export async function createOcsPipeline(spec: OcsPipelineSpec): Promise<OcsPipeline> {
  const { data } = await climateApiClient.post<OcsPipeline>("/pipelines", spec, {
    headers: JSON_HEADERS,
  });
  return data;
}

/** `revision` is the one the change was based on; a stale one is refused with 409. */
export async function updateOcsPipeline(
  pipelineId: string,
  change: OcsPipelineDefinition & { revision: number }
): Promise<OcsPipeline> {
  const { data } = await climateApiClient.put<OcsPipeline>(path(pipelineId), change, {
    headers: JSON_HEADERS,
  });
  return data;
}

/** Renders one interval and has the destination judge it without writing; going live needs a passed one. */
export async function dryRunOcsPipeline(
  pipelineId: string,
  interval: { start: string; end: string }
): Promise<OcsDryRun> {
  const { data } = await climateApiClient.post<OcsDryRun>(`${path(pipelineId)}/dry-run`, interval, {
    headers: JSON_HEADERS,
  });
  return data;
}

export async function setOcsPipelineMode(
  pipelineId: string,
  mode: OcsDeliveryMode
): Promise<OcsPipeline> {
  const { data } = await climateApiClient.post<OcsPipeline>(
    `${path(pipelineId)}/mode/${mode}`,
    {},
    { headers: JSON_HEADERS }
  );
  return data;
}

/** Starts one run over an explicit interval; OCS answers 202 with the run to poll. */
export async function startOcsPipelineRun(
  pipelineId: string,
  request: { start: string; end: string; mode: OcsRunMode }
): Promise<OcsPipelineRun> {
  const { data } = await climateApiClient.post<OcsPipelineRun>(
    `${path(pipelineId)}/runs`,
    request,
    {
      headers: JSON_HEADERS,
    }
  );
  return data;
}

export async function getOcsPipelineRun(
  pipelineId: string,
  runId: string
): Promise<OcsPipelineRun> {
  const { data } = await climateApiClient.get<OcsPipelineRun>(
    `${path(pipelineId)}/runs/${encodeURIComponent(runId)}`,
    { headers: JSON_HEADERS }
  );
  return data;
}

export async function listOcsWorkflows(): Promise<OcsWorkflow[]> {
  const { data } = await climateApiClient.get<{ processes?: OcsWorkflow[] }>("/process_graphs", {
    headers: JSON_HEADERS,
  });
  return data.processes ?? [];
}

export async function listOcsFeatureCollections(): Promise<
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

export async function listOcsDatasets(): Promise<Array<Record<string, unknown>>> {
  const { data } = await climateApiClient.get<{ items?: Array<Record<string, unknown>> }>(
    "/datasets",
    {
      headers: JSON_HEADERS,
    }
  );
  return data.items ?? [];
}

// --- workflow parameters, as OCS reads them (open_geo_service/pipelines/workflow.py) ---

const TEMPORAL_INTERVAL = "temporal-interval";

export function parameterSchema(parameter: OcsWorkflowParameter): Record<string, unknown> {
  return parameter.schema && typeof parameter.schema === "object" ? parameter.schema : {};
}

/** The parameters each run fills with its own interval; a pipeline never binds them. */
export function intervalParameters(workflow: OcsWorkflow): string[] {
  return workflow.parameters
    .filter((p) => typeof p.name === "string" && parameterSchema(p).subtype === TEMPORAL_INTERVAL)
    .map((p) => p.name);
}

/** Whether a pipeline can run the workflow: it takes an interval and does not save its own result. */
export function isPipelineReady(workflow: OcsWorkflow): boolean {
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
