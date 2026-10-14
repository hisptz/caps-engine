import axios from "axios";
import { climateApiClient } from "@/shared/clients/climateApi.ts";
import {
  buildAsyncPreferHeaders,
  extractAcceptedJobId,
  normalizeAsyncPostResponse,
} from "@/services/api/utils/climate/async.ts";
import {
  climateJobRegistry,
  isActiveClimateJobStatus,
  type ClimateJobKind,
  type TrackedClimateJob,
} from "@/services/api/utils/climate/jobRegistry.ts";
import {
  collectionNotFoundError,
  mapClimateAxiosError,
  handleClimateRequest,
} from "@/services/api/utils/climate/errors.ts";
import type {
  AsyncQuery,
  CreateIngestionBody,
  SyncDatasetBody,
} from "@/services/api/modules/climate/model.ts";

type StacCatalog = { links?: Array<{ rel: string; href: string }> };

function collectionIdFromHref(href: string): string | null {
  const segment = href.split(/[?#]/)[0]?.replace(/\/+$/, "").split("/").pop();
  return segment ? decodeURIComponent(segment) : null;
}

function jobStatusOf(data: unknown): string | null {
  if (typeof data === "object" && data !== null && "status" in data) {
    const status = (data as { status: unknown }).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

async function recordAcceptedJob(
  response: { status: number; headers: unknown },
  kind: ClimateJobKind,
  datasetId: string
): Promise<void> {
  const jobId = extractAcceptedJobId(response.status, response.headers as Record<string, unknown>);
  if (jobId) {
    await climateJobRegistry.record(jobId, kind, datasetId);
  }
}

export class ClimateService {
  async listCollections(): Promise<{ collections: unknown[] }> {
    return handleClimateRequest(async () => {
      const catalog = (await climateApiClient.get<StacCatalog>("/stac")).data;
      const ids = (catalog.links ?? [])
        .filter((link) => link.rel === "child")
        .map((link) => collectionIdFromHref(link.href))
        .filter((id): id is string => Boolean(id));
      const results = await Promise.allSettled(
        ids.map(
          async (id) =>
            (await climateApiClient.get<unknown>(`/stac/collections/${encodeURIComponent(id)}`))
              .data
        )
      );
      return {
        collections: results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        ),
      };
    });
  }

  async getCollection(id: string): Promise<unknown> {
    try {
      const response = await climateApiClient.get(`/stac/collections/${encodeURIComponent(id)}`);
      return response.data as unknown;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        throw collectionNotFoundError(id);
      }
      const mapped = mapClimateAxiosError(err, { collectionId: id });
      if (mapped) {
        throw mapped;
      }
      throw err;
    }
  }

  async listDataSources(): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> => (await climateApiClient.get("/data-sources")).data
    );
  }

  async getDataSource(id: string): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> =>
        (await climateApiClient.get(`/data-sources/${encodeURIComponent(id)}`)).data,
      { notFoundDetails: { dataSourceId: id } }
    );
  }

  async listIngestions(): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> => (await climateApiClient.get("/ingestions")).data
    );
  }

  async createIngestion(query: AsyncQuery, body: CreateIngestionBody): Promise<Response> {
    return handleClimateRequest(async () => {
      const response = await climateApiClient.post("/ingestions", body, {
        headers: buildAsyncPreferHeaders(query.async),
      });
      await recordAcceptedJob(response, "ingestion", body.dataset_id);
      return normalizeAsyncPostResponse(
        response.status,
        response.data,
        response.headers as Record<string, unknown>,
        query.async
      );
    });
  }

  async getIngestion(ingestionId: string): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> =>
        (await climateApiClient.get(`/ingestions/${encodeURIComponent(ingestionId)}`)).data,
      { notFoundDetails: { ingestionId } }
    );
  }

  async listActiveJobs(): Promise<{ jobs: TrackedClimateJob[] }> {
    const tracked = await climateJobRegistry.listActive();
    const refreshed = await Promise.all(
      tracked.map(async (job): Promise<TrackedClimateJob> => {
        try {
          const { data } = await climateApiClient.get<unknown>(
            `/ingestions/jobs/${encodeURIComponent(job.jobId)}`
          );
          const status = jobStatusOf(data) ?? job.status;
          await climateJobRegistry.updateStatus(job.jobId, status);
          return { ...job, status };
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            await climateJobRegistry.updateStatus(job.jobId, "not_found");
            return { ...job, status: "not_found" };
          }
          // climate-api unreachable: report the last known status
          return job;
        }
      })
    );
    return { jobs: refreshed.filter((job) => isActiveClimateJobStatus(job.status)) };
  }

  async getIngestionJob(jobId: string): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> => {
        const { data } = await climateApiClient.get<unknown>(
          `/ingestions/jobs/${encodeURIComponent(jobId)}`
        );
        const status = jobStatusOf(data);
        if (status) {
          await climateJobRegistry.updateStatus(jobId, status);
        }
        return data;
      },
      { notFoundDetails: { jobId } }
    );
  }

  async cancelIngestionJob(jobId: string): Promise<Response> {
    return handleClimateRequest(
      async () => {
        const response = await climateApiClient.delete(
          `/ingestions/jobs/${encodeURIComponent(jobId)}`
        );
        const status = jobStatusOf(response.data);
        if (status) {
          await climateJobRegistry.updateStatus(jobId, status);
        }
        return Response.json(response.data, { status: response.status });
      },
      { notFoundDetails: { jobId } }
    );
  }

  async syncDataset(
    datasetId: string,
    query: AsyncQuery,
    body: SyncDatasetBody
  ): Promise<Response> {
    return handleClimateRequest(
      async () => {
        const response = await climateApiClient.post(
          `/sync/${encodeURIComponent(datasetId)}`,
          body,
          { headers: buildAsyncPreferHeaders(query.async) }
        );
        await recordAcceptedJob(response, "sync", datasetId);
        return normalizeAsyncPostResponse(
          response.status,
          response.data,
          response.headers as Record<string, unknown>,
          query.async
        );
      },
      { notFoundDetails: { datasetId } }
    );
  }

  async planSync(datasetId: string, end: string | undefined): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> =>
        (
          await climateApiClient.get(`/sync/${encodeURIComponent(datasetId)}/plan`, {
            params: end !== undefined ? { end } : undefined,
          })
        ).data,
      { notFoundDetails: { datasetId } }
    );
  }
}
