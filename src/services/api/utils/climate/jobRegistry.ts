import { apiDb } from "@/services/api/utils/db.ts";
import { logger } from "@/shared/utils";

export type ClimateJobKind = "ingestion" | "sync";

export const ACTIVE_CLIMATE_JOB_STATUSES = ["accepted", "running", "retrying"];

export type TrackedClimateJob = {
  jobId: string;
  kind: string;
  datasetId: string | null;
  status: string;
  createdAt: Date;
};

export function isActiveClimateJobStatus(status: string): boolean {
  return ACTIVE_CLIMATE_JOB_STATUSES.includes(status);
}

/**
 * The climate-api has no "list jobs" endpoint, so CAPS remembers every async job it
 * submits. Writes are best effort: a registry failure must never fail the proxied request.
 */
export const climateJobRegistry = {
  async record(jobId: string, kind: ClimateJobKind, datasetId: string | null): Promise<void> {
    try {
      await apiDb.climateJob.upsert({
        where: { jobId },
        create: { jobId, kind, datasetId },
        update: { kind, datasetId, status: "accepted", finishedAt: null },
      });
    } catch (err) {
      logger.warn(`Failed to record climate job ${jobId}: ${String(err)}`);
    }
  },

  async updateStatus(jobId: string, status: string): Promise<void> {
    try {
      await apiDb.climateJob.updateMany({
        where: { jobId, status: { not: status } },
        data: {
          status,
          finishedAt: isActiveClimateJobStatus(status) ? null : new Date(),
        },
      });
    } catch (err) {
      logger.warn(`Failed to update climate job ${jobId}: ${String(err)}`);
    }
  },

  async listActive(): Promise<TrackedClimateJob[]> {
    return apiDb.climateJob.findMany({
      where: { status: { in: ACTIVE_CLIMATE_JOB_STATUSES } },
      select: { jobId: true, kind: true, datasetId: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  },
};
