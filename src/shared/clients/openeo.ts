import axios from "axios";
import { z } from "zod";
import { climateApiClient } from "@/shared/clients/climateApi.ts";

export const openEoJobStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "finished",
  "error",
  "canceled",
]);

export type OpenEoJobStatus = z.infer<typeof openEoJobStatusSchema>;

export const openEoJobRecordSchema = z
  .object({
    id: z.string(),
    status: openEoJobStatusSchema,
    logs: z.string().nullable().optional(),
  })
  .passthrough();

export type OpenEoJobRecord = z.infer<typeof openEoJobRecordSchema>;

export const openEoJobCreateBodySchema = z.object({
  process: z.object({
    process_graph: z.record(z.string(), z.unknown()),
  }),
  title: z.string().optional(),
  description: z.string().optional(),
});

export type OpenEoJobCreateBody = z.infer<typeof openEoJobCreateBodySchema>;

export const openEoJobResultsSchema = z
  .object({
    assets: z
      .record(z.string(), z.object({ href: z.string().optional() }).passthrough())
      .optional(),
    links: z
      .array(z.object({ rel: z.string().optional(), href: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

export type OpenEoJobResults = z.infer<typeof openEoJobResultsSchema>;

export const TERMINAL_OPENEO_JOB_STATUSES = new Set<OpenEoJobStatus>([
  "finished",
  "error",
  "canceled",
]);

export const SUCCESS_OPENEO_JOB_STATUS: OpenEoJobStatus = "finished";

export async function createOpenEoJob(body: OpenEoJobCreateBody): Promise<OpenEoJobRecord> {
  try {
    const response = await climateApiClient.post<OpenEoJobRecord>("/jobs", body);
    const parsed = openEoJobRecordSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid openEO job create response: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      throw new Error(`openEO job validation failed: ${JSON.stringify(err.response.data)}`, {
        cause: err,
      });
    }
    throw err;
  }
}

export async function startOpenEoJob(jobId: string): Promise<void> {
  try {
    await climateApiClient.post(`/jobs/${encodeURIComponent(jobId)}/results`);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      throw new Error(`openEO job start failed: ${JSON.stringify(err.response.data)}`, {
        cause: err,
      });
    }
    throw err;
  }
}

export async function getOpenEoJob(jobId: string): Promise<OpenEoJobRecord> {
  const response = await climateApiClient.get<unknown>(`/jobs/${encodeURIComponent(jobId)}`);
  const parsed = openEoJobRecordSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Invalid openEO job response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function getOpenEoJobResults(jobId: string): Promise<OpenEoJobResults> {
  const response = await climateApiClient.get<unknown>(
    `/jobs/${encodeURIComponent(jobId)}/results`
  );
  const parsed = openEoJobResultsSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Invalid openEO job results response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function resolveResultFilename(): string {
  return "result.json";
}

export async function downloadOpenEoJobResult(jobId: string, filename: string): Promise<unknown> {
  const response = await climateApiClient.get<unknown>(
    `/jobs/${encodeURIComponent(jobId)}/results/${encodeURIComponent(filename)}`
  );
  return response.data;
}
