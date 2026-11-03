import { Elysia } from "elysia";
import { WorkflowService } from "@/services/api/modules/workflows/service.ts";
import {
  createWorkflowBody,
  idParams,
  listWorkflowRunsQuery,
  memberParams,
  runIdParams,
  runWorkflowBody,
  updateWorkflowBody,
} from "@/services/api/modules/workflows/model.ts";

const workflowService = new WorkflowService();

export const workflowsModule = new Elysia({ prefix: "/workflows", tags: ["Workflows"] })
  .get("/", () => workflowService.listWorkflows(), {
    detail: {
      summary: "List workflows",
      description: "All workflows with their pipeline count and latest run",
      operationId: "listWorkflows",
      responses: { "200": { description: "Workflow list" } },
    },
  })
  .post(
    "/",
    ({ body, set }) => {
      set.status = 201;
      return workflowService.createWorkflow(body);
    },
    {
      body: createWorkflowBody,
      detail: {
        summary: "Create workflow",
        description: "Create a workflow; add pipelines to it afterwards",
        operationId: "createWorkflow",
        responses: {
          "201": { description: "Created workflow" },
          "400": { description: "Validation error or invalid cron expression" },
          "409": { description: "A workflow with that name already exists" },
        },
      },
    }
  )
  .get("/runs/:runId", ({ params }) => workflowService.getRun(params.runId), {
    params: runIdParams,
    detail: {
      summary: "Get workflow run",
      description: "A workflow run with its executions, status and connectors still deciding",
      operationId: "getWorkflowRun",
      responses: {
        "200": { description: "Workflow run detail" },
        "404": { description: "Workflow run not found" },
      },
    },
  })
  .get("/:id", ({ params }) => workflowService.getWorkflow(params.id), {
    params: idParams,
    detail: {
      summary: "Get workflow",
      description:
        "A workflow with its pipelines, the connectors leaving them and the pipelines it starts with",
      operationId: "getWorkflow",
      responses: {
        "200": { description: "Workflow detail" },
        "404": { description: "Workflow not found" },
      },
    },
  })
  .put("/:id", ({ params, body }) => workflowService.updateWorkflow(params.id, body), {
    params: idParams,
    body: updateWorkflowBody,
    detail: {
      summary: "Update workflow",
      description: "Partially update a workflow; cronExpr null removes its schedule",
      operationId: "updateWorkflow",
      responses: {
        "200": { description: "Updated workflow" },
        "400": { description: "Validation error or invalid cron expression" },
        "404": { description: "Workflow not found" },
        "409": { description: "A workflow with that name already exists" },
      },
    },
  })
  .delete("/:id", ({ params }) => workflowService.deleteWorkflow(params.id), {
    params: idParams,
    detail: {
      summary: "Delete workflow",
      description: "Delete a workflow and its run history; its pipelines are kept",
      operationId: "deleteWorkflow",
      responses: {
        "200": { description: "Deleted workflow" },
        "404": { description: "Workflow not found" },
      },
    },
  })
  .put(
    "/:id/pipelines/:pipelineId",
    ({ params }) => workflowService.addPipeline(params.id, params.pipelineId),
    {
      params: memberParams,
      detail: {
        summary: "Add pipeline to workflow",
        description: "A pipeline belongs to at most one workflow",
        operationId: "addWorkflowPipeline",
        responses: {
          "200": { description: "Updated workflow" },
          "404": { description: "Workflow or pipeline not found" },
          "409": { description: "Pipeline is already in another workflow" },
        },
      },
    }
  )
  .delete(
    "/:id/pipelines/:pipelineId",
    ({ params }) => workflowService.removePipeline(params.id, params.pipelineId),
    {
      params: memberParams,
      detail: {
        summary: "Remove pipeline from workflow",
        description: "The pipeline is kept, no longer in a workflow",
        operationId: "removeWorkflowPipeline",
        responses: {
          "200": { description: "Updated workflow" },
          "404": { description: "Pipeline is not in this workflow" },
        },
      },
    }
  )
  .post(
    "/:id/run",
    ({ params, body, set }) => {
      set.status = 201;
      return workflowService.runWorkflow(params.id, body ?? {});
    },
    {
      params: idParams,
      body: runWorkflowBody.optional(),
      detail: {
        summary: "Run workflow",
        description:
          "Start the workflow's first pipelines (those no connector inside it starts) together as one workflow run. With a period, their data steps cover that fixed range instead of their own windows (e.g. a backfill)",
        operationId: "runWorkflow",
        responses: {
          "201": {
            description: "Started workflow run, with any first pipelines that were skipped",
          },
          "400": { description: "Invalid period range" },
          "404": { description: "Workflow not found" },
          "409": { description: "Workflow is inactive or has no pipelines" },
        },
      },
    }
  )
  .get("/:id/runs", ({ params, query }) => workflowService.listRuns(params.id, query), {
    params: idParams,
    query: listWorkflowRunsQuery,
    detail: {
      summary: "List workflow runs",
      description: "Paginated runs of a workflow, newest first, each with its derived status",
      operationId: "listWorkflowRuns",
      responses: {
        "200": { description: "Paginated workflow runs" },
        "404": { description: "Workflow not found" },
      },
    },
  });
