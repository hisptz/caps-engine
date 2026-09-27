import axios from "axios";
import { z } from "zod";
import { climateApiClient } from "@/shared/clients/climateApi.ts";
import {
  ASYNC_PREFER_HEADER,
  extractJobIdFromLocation,
} from "@/services/api/utils/climate/async.ts";

export const climateSyncActionSchema = z.enum(["rematerialize", "append", "no_op", "not_syncable"]);

export type ClimateSyncAction = z.infer<typeof climateSyncActionSchema>;

/** Planner actions that download data; the others leave the dataset as it is. */
export const WORKING_SYNC_ACTIONS = new Set<ClimateSyncAction>(["append", "rematerialize"]);

export const climateSyncPlanSchema = z
  .object({
    action: climateSyncActionSchema,
    reason: z.string(),
    message: z.string(),
    current_start: z.string().nullable().optional(),
    current_end: z.string().nullable().optional(),
    target_end: z.string().nullable().optional(),
    delta_start: z.string().nullable().optional(),
    delta_end: z.string().nullable().optional(),
  })
  .passthrough();

export type ClimateSyncPlan = z.infer<typeof climateSyncPlanSchema>;

export const climateJobStatusSchema = z.enum([
  "accepted",
  "running",
  "retrying",
  "successful",
  "failed",
  "cancelled",
]);

export type ClimateJobStatus = z.infer<typeof climateJobStatusSchema>;

export const TERMINAL_CLIMATE_JOB_STATUSES = new Set<ClimateJobStatus>([
  "successful",
  "failed",
  "cancelled",
]);

export const climateJobRecordSchema = z
  .object({
    jobID: z.string(),
    status: climateJobStatusSchema,
    error: z.object({ type: z.string(), message: z.string() }).nullable().optional(),
  })
  .passthrough();

export type ClimateJobRecord = z.infer<typeof climateJobRecordSchema>;

/** A sync either queued as a background job, or finished inline (e.g. nothing to download). */
export type StartedClimateSync =
  | { kind: "queued"; jobId: string }
  | { kind: "completed"; status: string; message: string | null };

const syncCompletedResponseSchema = z
  .object({ status: z.string(), message: z.string().nullable().optional() })
  .passthrough();

/**
 * Rewrites a climate API failure as an error naming the dataset and the API's own detail,
 * so it reads well in the step log instead of as a bare "Request failed with status code".
 */
function describeClimateError(action: string, datasetId: string, err: unknown): Error {
  if (axios.isAxiosError(err) && err.response) {
    const status = err.response.status;
    const data: unknown = err.response.data;
    const detail =
      typeof data === "object" && data !== null && "detail" in data
        ? JSON.stringify((data as { detail: unknown }).detail)
        : JSON.stringify(data);
    const hint =
      status === 404
        ? " — the dataset no longer exists in the Open Climate Service"
        : status === 409
          ? " — a sync for this dataset is probably already running; retry once it finishes"
          : "";
    return new Error(
      `Could not ${action} climate dataset "${datasetId}" (${status}): ${detail}${hint}`,
      { cause: err }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Could not ${action} climate dataset "${datasetId}": ${message}`, {
    cause: err,
  });
}

/** GET /sync/{dataset_id}/plan — what a sync would do, without downloading anything. */
export async function planClimateDatasetSync(
  datasetId: string,
  end?: string
): Promise<ClimateSyncPlan> {
  let data: unknown;
  try {
    const response = await climateApiClient.get(`/sync/${encodeURIComponent(datasetId)}/plan`, {
      params: end !== undefined ? { end } : undefined,
    });
    data = response.data;
  } catch (err) {
    throw describeClimateError("plan a sync for", datasetId, err);
  }
  const parsed = climateSyncPlanSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid sync plan for climate dataset "${datasetId}": ${parsed.error.message}`
    );
  }
  return parsed.data;
}

/** POST /sync/{dataset_id} with `Prefer: respond-async`, publishing the synced version. */
export async function startClimateDatasetSync(
  datasetId: string,
  end?: string
): Promise<StartedClimateSync> {
  try {
    const response = await climateApiClient.post(
      `/sync/${encodeURIComponent(datasetId)}`,
      { end: end ?? null, publish: true },
      { headers: { Prefer: ASYNC_PREFER_HEADER } }
    );
    if (response.status === 202) {
      const headers = response.headers as Record<string, unknown>;
      const location = typeof headers.location === "string" ? headers.location : undefined;
      const jobId = extractJobIdFromLocation(location);
      if (!jobId) {
        throw new Error(
          `Sync for climate dataset "${datasetId}" was accepted without a job location`
        );
      }
      return { kind: "queued", jobId };
    }
    const parsed = syncCompletedResponseSchema.safeParse(response.data);
    return {
      kind: "completed",
      status: parsed.success ? parsed.data.status : "completed",
      message: parsed.success ? (parsed.data.message ?? null) : null,
    };
  } catch (err) {
    if (err instanceof Error && !axios.isAxiosError(err)) throw err;
    throw describeClimateError("start a sync for", datasetId, err);
  }
}

/** GET /ingestions/jobs/{job_id} */
export async function getClimateJob(jobId: string): Promise<ClimateJobRecord> {
  const response = await climateApiClient.get(`/ingestions/jobs/${encodeURIComponent(jobId)}`);
  const parsed = climateJobRecordSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Invalid climate job record for ${jobId}: ${parsed.error.message}`);
  }
  return parsed.data;
}
