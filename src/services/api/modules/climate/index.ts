import { Elysia } from "elysia";
import { ClimateService } from "@/services/api/modules/climate/service.ts";
import {
  collectionIdParams,
  dataSourceIdParams,
  ingestionIdParams,
  jobIdParams,
  syncDatasetIdParams,
  asyncQuerySchema,
  syncPlanQuerySchema,
  createIngestionSchema,
  syncDatasetSchema,
  geoservicePipelineIdParams,
  geoservicePipelineModeParams,
  geoservicePipelineCreateSchema,
  geoservicePipelineChangeSchema,
  geoservicePipelineIntervalSchema,
} from "@/services/api/modules/climate/model.ts";
import { GeoservicePipelinesService } from "@/services/api/modules/climate/pipelinesService.ts";

const climateService = new ClimateService();
const geoservicePipelines = new GeoservicePipelinesService();

const GEOSERVICE_UNAVAILABLE = { "502": { description: "Climate API service unavailable" } };

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
    params: collectionIdParams,
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
  .get("/ingestions/jobs", () => climateService.listActiveJobs(), {
    detail: {
      summary: "List active ingestion jobs",
      description:
        "List async ingestion and sync jobs submitted through CAPS that are still accepted, running or retrying. Statuses are refreshed from the climate-api on each call.",
      operationId: "listActiveClimateIngestionJobs",
      responses: {
        "200": { description: "Active jobs, as `{ jobs: [...] }`" },
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
  )
  // --- geoservice pipelines: CAPS creates and edits them; the geoservice-pipeline-run step runs them ---
  .get("/pipelines", () => geoservicePipelines.list(), {
    detail: {
      summary: "List geoservice pipelines",
      description: "Pipelines defined in Open Geo Service (workflow, inputs, DHIS2 mapping).",
      operationId: "listOcsPipelines",
      responses: { "200": { description: "`{ items: [...] }`" }, ...GEOSERVICE_UNAVAILABLE },
    },
  })
  .get("/pipelines/options", () => geoservicePipelines.options(), {
    detail: {
      summary: "Geoservice pipeline setup options",
      description:
        "Pipeline-ready workflows with the parameters a pipeline binds, datasets, feature collections and named DHIS2 connections.",
      operationId: "getOcsPipelineOptions",
      responses: { "200": { description: "Options" }, ...GEOSERVICE_UNAVAILABLE },
    },
  })
  .get("/pipelines/:id", ({ params }) => geoservicePipelines.get(params.id), {
    params: geoservicePipelineIdParams,
    detail: {
      summary: "Get geoservice pipeline",
      operationId: "getOcsPipeline",
      responses: {
        "200": { description: "The pipeline, resolved, with its latest run" },
        "404": { description: "Not found" },
        ...GEOSERVICE_UNAVAILABLE,
      },
    },
  })
  .post("/pipelines", ({ body }) => geoservicePipelines.create(body), {
    body: geoservicePipelineCreateSchema,
    detail: {
      summary: "Create geoservice pipeline",
      description:
        "Saved with delivery policy `manual` (CAPS starts its runs). geoservice validates it first and refuses a failing one with 422 and its checks.",
      operationId: "createOcsPipeline",
      responses: {
        "200": { description: "Created" },
        "409": { description: "The id is taken" },
        "422": { description: "Validation failed; checks under details" },
        ...GEOSERVICE_UNAVAILABLE,
      },
    },
  })
  .put("/pipelines/:id", ({ params, body }) => geoservicePipelines.update(params.id, body), {
    params: geoservicePipelineIdParams,
    body: geoservicePipelineChangeSchema,
    detail: {
      summary: "Update geoservice pipeline",
      description:
        "Replace the definition. `revision` is the one read; a stale one is refused with 409.",
      operationId: "updateOcsPipeline",
      responses: {
        "200": { description: "Saved" },
        "409": { description: "Changed in geoservice since it was read" },
        "422": { description: "Validation failed" },
        ...GEOSERVICE_UNAVAILABLE,
      },
    },
  })
  .post(
    "/pipelines/:id/dry-run",
    ({ params, body }) => geoservicePipelines.dryRun(params.id, body),
    {
      params: geoservicePipelineIdParams,
      body: geoservicePipelineIntervalSchema,
      detail: {
        summary: "Dry-run geoservice pipeline",
        description:
          "Render one interval and have DHIS2 judge it without writing. Going live needs a passed dry run.",
        operationId: "dryRunOcsPipeline",
        responses: {
          "200": { description: "The dry run: values rendered and DHIS2's verdict" },
          ...GEOSERVICE_UNAVAILABLE,
        },
      },
    }
  )
  .post(
    "/pipelines/:id/mode/:mode",
    ({ params }) => geoservicePipelines.setMode(params.id, params.mode),
    {
      params: geoservicePipelineModeParams,
      detail: {
        summary: "Set geoservice pipeline delivery mode",
        description: "dry_run, live (needs a passed dry run of the current bindings) or paused.",
        operationId: "setOcsPipelineMode",
        responses: {
          "200": { description: "The pipeline" },
          "409": { description: "Cannot go live yet" },
          ...GEOSERVICE_UNAVAILABLE,
        },
      },
    }
  );
