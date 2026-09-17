import { Elysia } from "elysia";
import { getModels } from "@/services/api/modules/models/service.ts";

export const modelsModule = new Elysia({ prefix: "/models", tags: ["Models"] }).get(
  "/",
  () => getModels(),
  {
    detail: {
      summary: "List configured CHAP models",
      description:
        "Proxies GET /v1/crud/configured-models from CHAP. Always returns HTTP 200; error/code fields present when CHAP is unreachable.",
      operationId: "listModels",
      responses: {
        "200": {
          description:
            "List of configured models (may be empty with error/code fields if CHAP is unavailable)",
        },
      },
    },
  }
);
