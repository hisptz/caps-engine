import { SQL } from "bun";
import { createDbClient } from "@/shared/clients/db.ts";
import { TriggerService } from "@/services/scheduler/trigger-service.ts";
import { Scheduler } from "@/services/scheduler/scheduler.ts";
import type { ScheduleEventListen } from "@/services/scheduler/schedule-events.ts";
import { serviceLogger } from "@/shared/utils/logger.ts";
import { ServiceType } from "@/shared/constants/service.ts";
import { env } from "@/shared/utils";

type SqlWithListen = {
  listen: ScheduleEventListen;
  close: (options?: { timeout?: number }) => Promise<void>;
};

async function startScheduler() {
  serviceLogger.info(ServiceType.SCHEDULER, "Connecting to Postgres...");
  const prisma = createDbClient();
  const sql = new SQL(env.DATABASE_URL) as SQL & SqlWithListen;

  const triggerService = new TriggerService(prisma);
  const scheduler = new Scheduler(prisma, triggerService, (channel, onNotify, onConnect) =>
    sql.listen(channel, onNotify, onConnect)
  );
  await scheduler.start();
  serviceLogger.info(ServiceType.SCHEDULER, "Started");

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on("SIGTERM", async () => {
    serviceLogger.info(ServiceType.SCHEDULER, "SIGTERM received, shutting down...");
    await scheduler.stop();
    await sql.close();
    await prisma.$disconnect();
    serviceLogger.info(ServiceType.SCHEDULER, "Shutdown complete");
    process.exit(0);
  });
}

startScheduler().catch((err) => {
  serviceLogger.error(ServiceType.SCHEDULER, `Fatal startup error: ${String(err)}`);
  process.exit(1);
});
