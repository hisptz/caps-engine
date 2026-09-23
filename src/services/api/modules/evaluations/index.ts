import { Elysia } from "elysia";
import { z } from "zod";
import { getEvaluations, getPredictionSetup } from "@/services/api/modules/evaluations/service.ts";

const predictionSetupIdParams = z.object({ id: z.coerce.number().int().positive() });

export const evaluationsModule = new Elysia({ tags: ["Evaluations"] })
  .get("/evaluations", () => getEvaluations(), {
    detail: {
      summary: "List CHAP evaluations (backtests)",
      description:
        "Proxies GET /v1/crud/backtests from CHAP. Each evaluation carries `predictionSetupId`, which is null when no prediction setup has been created for it yet. Always returns HTTP 200; error/code fields present when CHAP is unreachable.",
      operationId: "listEvaluations",
      responses: {
        "200": {
          description:
            "List of evaluations (may be empty with error/code fields if CHAP is unavailable)",
        },
      },
    },
  })
  .get("/prediction-setups/:id", ({ params }) => getPredictionSetup(params.id), {
    params: predictionSetupIdParams,
    detail: {
      summary: "Get a CHAP prediction setup",
      description:
        "Proxies GET /v1/crud/prediction-setups/{id} from CHAP. Returns `setup: null` when the setup does not exist. Always returns HTTP 200; error/code fields present when CHAP is unreachable.",
      operationId: "getPredictionSetup",
      responses: {
        "200": { description: "Prediction setup detail, or null when it does not exist" },
      },
    },
  });
