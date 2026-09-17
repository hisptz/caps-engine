import { Elysia } from "elysia";
import { PipelineService } from "@/services/api/modules/pipelines/service.ts";
import {
  idParams,
  stepParams,
  listPipelinesQuery,
  createPipelineBody,
  updatePipelineBody,
  createStepBody,
  updateStepBody,
  createScheduleBody,
} from "@/services/api/modules/pipelines/model.ts";

const pipelineService = new PipelineService();

export const pipelinesModule = new Elysia({ prefix: "/pipelines", tags: ["Pipelines"] })
  .get("/", ({ query }) => pipelineService.listPipelines(query), {
    query: listPipelinesQuery,
    detail: {
      summary: "List pipelines",
      description: "Paginated list of pipeline definitions, optionally filtered by active status",
      operationId: "listPipelines",
      responses: { "200": { description: "Paginated pipeline list" } },
    },
  })
  .post(
    "/",
    ({ body, set }) => {
      set.status = 201;
      return pipelineService.createPipeline(body);
    },
    {
      body: createPipelineBody,
      detail: {
        summary: "Create pipeline",
        description: "Create a new pipeline definition",
        operationId: "createPipeline",
        responses: {
          "201": { description: "Created pipeline" },
          "400": { description: "Validation error or duplicate name" },
        },
      },
    }
  )
  .get("/:id", ({ params }) => pipelineService.getPipeline(params.id), {
    params: idParams,
    detail: {
      summary: "Get pipeline",
      description: "Get a pipeline definition with its steps and schedules",
      operationId: "getPipeline",
      responses: {
        "200": { description: "Pipeline detail" },
        "404": { description: "Pipeline not found" },
      },
    },
  })
  .put("/:id", ({ params, body }) => pipelineService.updatePipeline(params.id, body), {
    params: idParams,
    body: updatePipelineBody,
    detail: {
      summary: "Update pipeline",
      description: "Partially update a pipeline definition",
      operationId: "updatePipeline",
      responses: {
        "200": { description: "Updated pipeline" },
        "400": { description: "Duplicate name" },
        "404": { description: "Pipeline not found" },
      },
    },
  })
  .delete("/:id", ({ params }) => pipelineService.deletePipeline(params.id), {
    params: idParams,
    detail: {
      summary: "Delete pipeline",
      description: "Delete a pipeline definition. Fails if active executions exist.",
      operationId: "deletePipeline",
      responses: {
        "200": { description: "Deleted pipeline" },
        "404": { description: "Pipeline not found" },
        "409": { description: "Pipeline has active executions" },
      },
    },
  })
  .get("/:id/steps", ({ params }) => pipelineService.listSteps(params.id), {
    params: idParams,
    detail: {
      summary: "List pipeline steps",
      description: "Get all steps for a pipeline, ordered by stepOrder",
      tags: ["Steps"],
      operationId: "listPipelineSteps",
      responses: {
        "200": { description: "Step list" },
        "404": { description: "Pipeline not found" },
      },
    },
  })
  .post(
    "/:id/steps",
    ({ params, body, set }) => {
      set.status = 201;
      return pipelineService.createStep(params.id, body);
    },
    {
      params: idParams,
      body: createStepBody,
      detail: {
        summary: "Create pipeline step",
        description: "Add a step to a pipeline",
        tags: ["Steps"],
        operationId: "createPipelineStep",
        responses: {
          "201": { description: "Created step" },
          "400": { description: "Validation error" },
          "404": { description: "Pipeline not found" },
          "409": { description: "stepOrder already taken for this pipeline" },
        },
      },
    }
  )
  .put(
    "/:id/steps/:stepId",
    ({ params, body }) => pipelineService.updateStep(params.stepId, body),
    {
      params: stepParams,
      body: updateStepBody,
      detail: {
        summary: "Update pipeline step",
        description: "Partially update a pipeline step",
        tags: ["Steps"],
        operationId: "updatePipelineStep",
        responses: {
          "200": { description: "Updated step" },
          "404": { description: "Step not found" },
          "409": { description: "stepOrder already taken for this pipeline" },
        },
      },
    }
  )
  .delete("/:id/steps/:stepId", ({ params }) => pipelineService.deleteStep(params.stepId), {
    params: stepParams,
    detail: {
      summary: "Delete pipeline step",
      description: "Remove a step from a pipeline",
      tags: ["Steps"],
      operationId: "deletePipelineStep",
      responses: {
        "200": { description: "Deleted step" },
        "404": { description: "Step not found" },
      },
    },
  })
  .get("/:id/schedules", ({ params }) => pipelineService.listSchedules(params.id), {
    params: idParams,
    detail: {
      summary: "List pipeline schedules",
      description: "Get all schedules for a pipeline",
      tags: ["Schedules"],
      operationId: "listPipelineSchedules",
      responses: {
        "200": { description: "Schedule list" },
        "404": { description: "Pipeline not found" },
      },
    },
  })
  .post(
    "/:id/schedules",
    ({ params, body, set }) => {
      set.status = 201;
      return pipelineService.createSchedule(params.id, body);
    },
    {
      params: idParams,
      body: createScheduleBody,
      detail: {
        summary: "Create schedule",
        description: "Add a cron schedule to a pipeline",
        tags: ["Schedules"],
        operationId: "createPipelineSchedule",
        responses: {
          "201": { description: "Created schedule" },
          "400": { description: "Invalid cron expression or input context" },
          "404": { description: "Pipeline not found" },
        },
      },
    }
  );
