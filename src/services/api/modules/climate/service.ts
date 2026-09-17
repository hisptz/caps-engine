import axios from "axios";
import { climateApiClient } from "@/shared/clients/climateApi.ts";
import {
  buildAsyncPreferHeaders,
  normalizeAsyncPostResponse,
} from "@/services/api/utils/climate/async.ts";
import {
  datasetNotFoundError,
  mapClimateAxiosError,
  handleClimateRequest,
} from "@/services/api/utils/climate/errors.ts";
import type {
  AsyncQuery,
  CreateIngestionBody,
  SyncDatasetBody,
} from "@/services/api/modules/climate/model.ts";

export class ClimateService {
  async listDatasets(): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> => (await climateApiClient.get("/datasets")).data
    );
  }

  async getDataset(id: string): Promise<unknown> {
    try {
      const response = await climateApiClient.get(`/datasets/${encodeURIComponent(id)}`);
      return response.data as unknown;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        throw datasetNotFoundError(id);
      }
      const mapped = mapClimateAxiosError(err, { datasetId: id });
      if (mapped) {
        throw mapped;
      }
      throw err;
    }
  }

  async listDatasetTemplates(): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> => (await climateApiClient.get("/dataset-templates/")).data
    );
  }

  async getDatasetTemplate(id: string): Promise<unknown> {
    return handleClimateRequest(
      async (): Promise<unknown> =>
        (await climateApiClient.get(`/dataset-templates/${encodeURIComponent(id)}`)).data,
      { notFoundDetails: { datasetTemplateId: id } }
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
