import { Elysia } from "elysia";
import { getHandlerCatalog } from "@/services/api/modules/handlers/service.ts";

export const handlersModule = new Elysia({ prefix: "/handlers", tags: ["Handlers"] }).get(
  "/",
  () => getHandlerCatalog(),
  {
    detail: {
      summary: "List pipeline step handlers",
      description:
        "Returns the CAPS worker handler catalog with display metadata and JSON Schema for config/context.",
      operationId: "listHandlers",
      responses: {
        "200": { description: "Handler catalog" },
      },
    },
  }
);
