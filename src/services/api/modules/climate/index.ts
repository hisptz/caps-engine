import { Elysia } from "elysia";
import { ClimateService } from "@/services/api/modules/climate/service.ts";
import {
  datasetIdParams,
  dataSourceIdParams,
  ingestionIdParams,
  jobIdParams,
  syncDatasetIdParams,
  asyncQuerySchema,
  syncPlanQuerySchema,
  createIngestionSchema,
  syncDatasetSchema,
} from "@/services/api/modules/climate/model.ts";

const climateService = new ClimateService();

export const climateModule = new Elysia({ prefix: "/climate", tags: ["climate"] })
  .get("/collections", () => climateService.listCollections(), {
    detail: {
      summary: "List climate collections",
      description:
        "List published collections from the climate-api STAC catalogue. Datasets appear here once ingestion has published them.",
      operationId: "listClimateCollections",
      responses: {
        "200": { description: "STAC collections, as `{ collections: [...] }`" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/collections/:id", ({ params }) => climateService.getCollection(params.id), {
    params: datasetIdParams,
    detail: {
      summary: "Get climate collection",
      description: "Get one published STAC collection from the climate-api catalogue",
      operationId: "getClimateCollection",
      responses: {
        "200": { description: "STAC collection" },
        "404": { description: "Collection not found" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/data-sources", () => climateService.listDataSources(), {
    detail: {
      summary: "List data sources",
      description: "Return the data sources the climate-api can ingest from",
      operationId: "listClimateDataSources",
      responses: {
        "200": { description: "List of data sources" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/data-sources/:id", ({ params }) => climateService.getDataSource(params.id), {
    params: dataSourceIdParams,
    detail: {
      summary: "Get data source",
      description: "Get a single data source by ID with derived coverage metadata",
      operationId: "getClimateDataSource",
      responses: {
        "200": { description: "Data source detail" },
        "404": { description: "Data source not found" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/ingestions", () => climateService.listIngestions(), {
    detail: {
      summary: "List ingestions",
      description: "List ingestion run records from the climate-api service",
      operationId: "listClimateIngestions",
      responses: {
        "200": { description: "List of ingestion records" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .post("/ingestions", ({ query, body }) => climateService.createIngestion(query, body), {
    query: asyncQuerySchema,
    body: createIngestionSchema,
    detail: {
      summary: "Create ingestion",
      description:
        "Create or update a managed dataset from a data source. Use ?async=true (default) to queue as a background job.",
      operationId: "createClimateIngestion",
      responses: {
        "200": { description: "Ingestion accepted (async) or completed (sync)" },
        "422": { description: "Validation error" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get(
    "/ingestions/:ingestionId",
    ({ params }) => climateService.getIngestion(params.ingestionId),
    {
      params: ingestionIdParams,
      detail: {
        summary: "Get ingestion",
        description: "Return the managed dataset view created for a given ingestion",
        operationId: "getClimateIngestion",
        responses: {
          "200": { description: "Ingestion record" },
          "404": { description: "Ingestion not found" },
          "502": { description: "Climate API service unavailable" },
        },
      },
    }
  )
  .get("/ingestions/jobs/:jobId", ({ params }) => climateService.getIngestionJob(params.jobId), {
    params: jobIdParams,
    detail: {
      summary: "Get ingestion job",
      description: "Return the status of an async ingestion or sync job",
      operationId: "getClimateIngestionJob",
      responses: {
        "200": { description: "Job record" },
        "404": { description: "Job not found" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .delete(
    "/ingestions/jobs/:jobId",
    ({ params }) => climateService.cancelIngestionJob(params.jobId),
    {
      params: jobIdParams,
      detail: {
        summary: "Cancel ingestion job",
        description: "Request cooperative cancellation for an async ingestion or sync job",
        operationId: "cancelClimateIngestionJob",
        responses: {
          "202": { description: "Cancellation accepted" },
          "404": { description: "Job not found" },
          "502": { description: "Climate API service unavailable" },
        },
      },
    }
  )
  .post(
    "/sync/:datasetId",
    ({ params, query, body }) => climateService.syncDataset(params.datasetId, query, body),
    {
      params: syncDatasetIdParams,
      query: asyncQuerySchema,
      body: syncDatasetSchema,
      detail: {
        summary: "Sync dataset",
        description:
          "Sync a managed dataset forward from its latest available time step. Use ?async=true (default) to queue as a background job.",
        operationId: "syncClimateDataset",
        responses: {
          "200": { description: "Sync accepted (async) or completed (sync)" },
          "422": { description: "Validation error" },
          "502": { description: "Climate API service unavailable" },
        },
      },
    }
  )
  .get(
    "/sync/:datasetId/plan",
    ({ params, query }) => climateService.planSync(params.datasetId, query.end),
    {
      params: syncDatasetIdParams,
      query: syncPlanQuerySchema,
      detail: {
        summary: "Plan dataset sync",
        description: "Return the sync plan for a managed dataset without starting a download",
        operationId: "planClimateDatasetSync",
        responses: {
          "200": { description: "Sync plan" },
          "404": { description: "Dataset not found" },
          "502": { description: "Climate API service unavailable" },
        },
      },
    }
  );
