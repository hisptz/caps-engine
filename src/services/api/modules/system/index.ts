import { Elysia } from "elysia";
import { getSystemInfo } from "@/services/api/modules/system/service.ts";

export const systemModule = new Elysia({ prefix: "/system", tags: ["System"] }).get(
  "/info",
  () => getSystemInfo(),
  {
    detail: {
      summary: "Get system info",
      description: "Returns information about the system",
      operationId: "getSystemInfo",
      responses: {
        "200": { description: "System info" },
        "500": { description: "Internal server error" },
      },
    },
  }
);
