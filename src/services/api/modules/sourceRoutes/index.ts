import { Elysia } from "elysia";
import { z } from "zod";
import { testSourceRoute } from "@/services/api/modules/sourceRoutes/service.ts";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";

const sourceRouteCodeParams = z.object({
  code: z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
    message: "Source route codes start with caps-src-",
  }),
});

export const sourceRoutesModule = new Elysia({ tags: ["Source routes"] }).get(
  "/source-routes/:code/test",
  ({ params }) => testSourceRoute(params.code),
  {
    params: sourceRouteCodeParams,
    detail: {
      summary: "Test a source instance route",
      description:
        "Calls `me` and `system/info` on the source DHIS2 instance through the staging DHIS2 route with this code, as the engine's staging user. Returns the source user, version and last analytics table generation. Always returns HTTP 200; `reachable` is false with error/code fields when the route can't be run.",
      operationId: "testSourceRoute",
      responses: {
        "200": { description: "Route test result" },
      },
    },
  }
);
