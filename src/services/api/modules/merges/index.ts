import { Elysia } from "elysia";
import { MergeService } from "@/services/api/modules/merges/service.ts";
import {
  createMergeBody,
  idParams,
  listMergeRunsQuery,
  listMergesQuery,
  mergeRunIdParams,
  updateMergeBody,
} from "@/services/api/modules/merges/model.ts";

const mergeService = new MergeService();

export const mergesModule = new Elysia({ prefix: "/merges", tags: ["Merges"] })
  .get("/", ({ query }) => mergeService.listMerges(query), {
    query: listMergesQuery,
    detail: {
      summary: "List merges",
      description:
        "List merges, optionally those of one workflow or those that wait for or start one pipeline",
      operationId: "listMerges",
      responses: { "200": { description: "Merge list" } },
    },
  })
  .post(
    "/",
    ({ body, set }) => {
      set.status = 201;
      return mergeService.createMerge(body);
    },
    {
      body: createMergeBody,
      detail: {
        summary: "Create merge",
        description:
          "Inside a workflow run, wait for several pipelines, then start one more when the trigger rule and condition are met",
        operationId: "createMerge",
        responses: {
          "201": { description: "Created merge" },
          "400": {
            description: "Validation error, invalid rule, or pipelines outside the workflow",
          },
          "404": { description: "Workflow not found" },
          "409": { description: "Merge would create a loop" },
        },
      },
    }
  )
  .get("/:id", ({ params }) => mergeService.getMerge(params.id), {
    params: idParams,
    detail: {
      summary: "Get merge",
      operationId: "getMerge",
      responses: {
        "200": { description: "Merge detail" },
        "404": { description: "Merge not found" },
      },
    },
  })
  .put("/:id", ({ params, body }) => mergeService.updateMerge(params.id, body), {
    params: idParams,
    body: updateMergeBody,
    detail: {
      summary: "Update merge",
      description: "Partially update a merge; its workflow cannot change",
      operationId: "updateMerge",
      responses: {
        "200": { description: "Updated merge" },
        "400": { description: "Validation error, invalid rule, or pipelines outside the workflow" },
        "404": { description: "Merge not found" },
        "409": { description: "Merge would create a loop" },
      },
    },
  })
  .delete("/:id", ({ params }) => mergeService.deleteMerge(params.id), {
    params: idParams,
    detail: {
      summary: "Delete merge",
      description: "Delete a merge and its run history",
      operationId: "deleteMerge",
      responses: {
        "200": { description: "Deleted merge" },
        "404": { description: "Merge not found" },
      },
    },
  })
  .get("/:id/runs", ({ params, query }) => mergeService.listMergeRuns(params.id, query), {
    params: idParams,
    query: listMergeRunsQuery,
    detail: {
      summary: "List merge runs",
      description: "Paginated decisions this merge made, newest first, with each source's arrival",
      operationId: "listMergeRuns",
      responses: {
        "200": { description: "Paginated merge runs" },
        "404": { description: "Merge not found" },
      },
    },
  })
  .post("/runs/:id/cancel", ({ params }) => mergeService.cancelMergeRun(params.id), {
    params: mergeRunIdParams,
    detail: {
      summary: "Cancel merge run",
      description: "Stop a merge run that is still waiting for its sources",
      operationId: "cancelMergeRun",
      responses: {
        "200": { description: "Cancelled merge run" },
        "404": { description: "Merge run not found" },
        "409": { description: "Merge run already decided" },
      },
    },
  });
