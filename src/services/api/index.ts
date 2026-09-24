import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { z } from "zod";
import { version } from "../../../package.json";
import { env, printBanner, serviceLogger } from "@/shared/utils";
import { ServiceType } from "@/shared/constants/service.ts";
import { initializeApiDb } from "@/services/api/utils/db.ts";
import { initializeApiAmqp } from "@/services/api/utils/amqp.ts";
import { requestLogger } from "@/services/api/plugins/logger.ts";
import { rateLimiter } from "@/services/api/plugins/rate-limiter.ts";
import { errorHandler } from "@/shared/api/errors.ts";
import { pipelinesModule } from "@/services/api/modules/pipelines/index.ts";
import { schedulesModule } from "@/services/api/modules/schedules/index.ts";
import { climateModule } from "@/services/api/modules/climate/index.ts";
import { monitoringModule } from "@/services/api/modules/monitoring/index.ts";
import { handlersModule } from "@/services/api/modules/handlers/index.ts";
import { evaluationsModule } from "@/services/api/modules/evaluations/index.ts";
import { systemModule } from "@/services/api/modules/system/index.ts";

initializeApiDb();
serviceLogger.info(ServiceType.API, `Initializing API server`);

try {
  await initializeApiAmqp();
} catch (err) {
  serviceLogger.error(ServiceType.API, `AMQP init failed: ${String(err)}`);
  process.exit(1);
}

const app = new Elysia()
  .use(cors({ origin: true }))
  .use(
    openapi({
      documentation: {
        info: {
          title: "CAPS API",
          version,
          description:
            "Climate Automation & Prediction Scheduler; An automation and scheduling layer for climate-informed disease prediction in DHIS2.",
        },
      },
      mapJsonSchema: { zod: z.toJSONSchema },
    })
  )
  .use(requestLogger())
  .use(rateLimiter())
  .onError(errorHandler)
  .use(pipelinesModule)
  .use(schedulesModule)
  .use(climateModule)
  .use(monitoringModule)
  .use(handlersModule)
  .use(evaluationsModule)
  .use(systemModule);

await printBanner("CAPS API");
const port = Number(env.PORT) || 4000;
app.listen(port, () => {
  serviceLogger.info(ServiceType.API, `Server running on http://localhost:${port}`);
});
