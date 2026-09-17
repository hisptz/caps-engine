import { Elysia } from "elysia";
import { ClimateService } from "@/services/api/modules/climate/service.ts";
import {
  datasetIdParams,
  datasetTemplateIdParams,
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
  .get("/datasets", () => climateService.listDatasets(), {
    detail: {
      summary: "List climate datasets",
      description: "List managed datasets from the configured climate-api service",
      operationId: "listClimateDatasets",
      responses: {
        "200": { description: "List of managed datasets" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/datasets/:id", ({ params }) => climateService.getDataset(params.id), {
    params: datasetIdParams,
    detail: {
      summary: "Get climate dataset",
      description: "Get one managed dataset from the configured climate-api service",
      operationId: "getClimateDataset",
      responses: {
        "200": { description: "Dataset detail" },
        "404": { description: "Dataset not found" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/dataset-templates", () => climateService.listDatasetTemplates(), {
    detail: {
      summary: "List dataset templates",
      description: "Return available dataset templates from the climate-api registry",
      operationId: "listClimateDatasetTemplates",
      responses: {
        "200": { description: "List of dataset templates" },
        "502": { description: "Climate API service unavailable" },
      },
    },
  })
  .get("/dataset-templates/:id", ({ params }) => climateService.getDatasetTemplate(params.id), {
    params: datasetTemplateIdParams,
    detail: {
      summary: "Get dataset template",
      description: "Get a single dataset template by ID with derived coverage metadata",
      operationId: "getClimateDatasetTemplate",
      responses: {
        "200": { description: "Dataset template detail" },
        "404": { description: "Dataset template not found" },
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
        "Create or update a managed dataset from a dataset template. Use ?async=true (default) to queue as a background job.",
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
