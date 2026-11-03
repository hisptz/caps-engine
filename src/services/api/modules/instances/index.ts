import { Elysia } from "elysia";
import { InstanceService } from "@/services/api/modules/instances/service.ts";
import { putInstanceBody, routeCodeParams } from "@/services/api/modules/instances/model.ts";

const instanceService = new InstanceService();

export const instancesModule = new Elysia({ tags: ["Connected instances"] })
  .get("/instances", () => instanceService.listInstances(), {
    detail: {
      summary: "List connected instance settings",
      description:
        "Connected instances that have settings, with their org unit match and number of mappings. The routes themselves are listed by DHIS2 (`GET /api/routes`).",
      operationId: "listInstances",
      responses: { "200": { description: "Instance settings" } },
    },
  })
  .get("/instances/:code", ({ params }) => instanceService.getInstance(params.code), {
    params: routeCodeParams,
    detail: {
      summary: "Get a connected instance's settings and mappings",
      description:
        "Settings, mappings (remote item → staging data element) and the pull/push steps that use the instance. Without settings yet, `configured` is false and `orgUnitMatch` is what its steps use most.",
      operationId: "getInstance",
      responses: { "200": { description: "Instance settings, mappings and steps" } },
    },
  })
  .put("/instances/:code", ({ params, body }) => instanceService.putInstance(params.code, body), {
    params: routeCodeParams,
    body: putInstanceBody,
    detail: {
      summary: "Replace a connected instance's settings and mappings",
      description:
        "Each mapping pairs a remote item with a staging data element and says which way values go (PULL or PUSH). Within an instance each is paired once; across instances a staging data element can be pulled into from one instance only, but pushed to several.",
      operationId: "putInstance",
      responses: {
        "200": { description: "Saved settings and mappings" },
        "400": { description: "Validation error, or a mapping listed twice" },
        "409": {
          description:
            "Another instance already pulls into a staging data element (`instance_mapping_conflict`), or a step still moves a mapping that is removed or now goes the other way (`instance_mapping_in_use`)",
        },
      },
    },
  })
  .delete("/instances/:code", ({ params }) => instanceService.deleteInstance(params.code), {
    params: routeCodeParams,
    detail: {
      summary: "Forget a connected instance's settings and mappings",
      description: "Call after deleting the instance's route. Steps that use it will fail.",
      operationId: "deleteInstance",
      responses: { "200": { description: "Removed" } },
    },
  })
  .get("/mappings", () => instanceService.listMappings(), {
    detail: {
      summary: "List every instance's mappings",
      description:
        "All mappings with their instance and direction, e.g. to see which staging data elements another instance already pulls into.",
      operationId: "listInstanceMappings",
      responses: { "200": { description: "Mappings" } },
    },
  });
