import axios from "axios";
import { climateApiClient } from "@/shared/clients/climateApi.ts";
import {
  buildAsyncPreferHeaders,
  normalizeAsyncPostResponse,
} from "@/services/api/utils/climate/async.ts";
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

  async getIngestionJob(jobId: string): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> =>
        (await climateApiClient.get(`/ingestions/jobs/${encodeURIComponent(jobId)}`)).data,
      { notFoundDetails: { jobId } }
    );
  }

  async cancelIngestionJob(jobId: string): Promise<Response> {
    return handleClimateRequest(
      async () => {
        const response = await climateApiClient.delete(
          `/ingestions/jobs/${encodeURIComponent(jobId)}`
        );
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
