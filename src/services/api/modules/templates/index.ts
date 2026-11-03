import { Elysia } from "elysia";
import { TemplateService } from "@/services/api/modules/templates/service.ts";
import {
  createFromTemplateBody,
  previewTemplateBody,
  templateParams,
  updateTemplateSetupBody,
  workflowIdParams,
} from "@/services/api/modules/templates/model.ts";

const templateService = new TemplateService();

export const templatesModule = new Elysia({ tags: ["Templates"] })
  .get("/templates", () => templateService.listTemplates(), {
    detail: {
      summary: "List workflow templates",
      description: "Templates a workflow can be created from, filled in with a few parameters",
      operationId: "listTemplates",
      responses: { "200": { description: "Template list" } },
    },
  })
  .post(
    "/templates/:template/preview",
    ({ params, body }) => templateService.preview(params.template, body.params),
    {
      params: templateParams,
      body: previewTemplateBody,
      detail: {
        summary: "Preview a workflow from a template",
        description:
          "Check the parameters (against the CHAP prediction setup, staging data elements and the source route) and show the pipelines they would create. Saves nothing.",
        operationId: "previewTemplate",
        responses: {
          "200": { description: "The plan, with errors and warnings" },
          "404": { description: "Template not found" },
        },
      },
    }
  )
  .post(
    "/templates/:template/workflows",
    ({ params, body, set }) => {
      set.status = 201;
      return templateService.create(params.template, body);
    },
    {
      params: templateParams,
      body: createFromTemplateBody,
      detail: {
        summary: "Create a workflow from a template",
        description:
          "Create the workflow, its pipelines and steps, and how they connect. With a backfill range, run it once over that range straight away.",
        operationId: "createWorkflowFromTemplate",
        responses: {
          "201": { description: "Created workflow, with the backfill run if one was started" },
          "400": { description: "Invalid backfill range" },
          "404": { description: "Template not found" },
          "409": { description: "A workflow or pipeline with that name already exists" },
          "422": { description: "The parameters are not valid; details lists every problem" },
        },
      },
    }
  )
  .get("/workflows/:id/template", ({ params }) => templateService.getSetup(params.id), {
    params: workflowIdParams,
    detail: {
      summary: "Get a workflow's template setup",
      description:
        "The template and parameters the workflow was made from, and the pipelines changed by hand since",
      operationId: "getWorkflowTemplateSetup",
      responses: {
        "200": { description: "Template setup" },
        "404": { description: "Workflow not found, or not made from a template" },
      },
    },
  })
  .put(
    "/workflows/:id/template",
    ({ params, body }) => templateService.updateSetup(params.id, body),
    {
      params: workflowIdParams,
      body: updateTemplateSetupBody,
      detail: {
        summary: "Update a workflow's template setup",
        description:
          "Apply new parameters, updating the same pipelines (steps that stay keep their history). Refuses when pipelines were changed by hand, unless force is set.",
        operationId: "updateWorkflowTemplateSetup",
        responses: {
          "200": { description: "Updated workflow" },
          "404": { description: "Workflow not found, or not made from a template" },
          "409": { description: "Pipelines were changed by hand, or a name is taken" },
          "422": { description: "The parameters are not valid; details lists every problem" },
        },
      },
    }
  );
