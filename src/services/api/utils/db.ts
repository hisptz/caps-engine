import { createDbClient } from "@/shared/clients/db.ts";
import type { PrismaClient } from "@db/client.ts";
import { serviceLogger } from "@/shared/utils";
import { ServiceType } from "@/shared/constants/service.ts";

export let apiDb: PrismaClient;

export function initializeApiDb() {
  serviceLogger.info(ServiceType.API, `Initializing database connection...`);
  apiDb = createDbClient();
  serviceLogger.info(ServiceType.API, `Database connection initialized`);
}
