import {
  registerHandler,
  type StepContext,
  type StepHandler,
  type TaskHandle,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  getClimateJob,
  planClimateDatasetSync,
  startClimateDatasetSync,
  TERMINAL_CLIMATE_JOB_STATUSES,
  WORKING_SYNC_ACTIONS,
  type ClimateJobStatus,
  type ClimateSyncAction,
} from "@/shared/clients/climateSync.ts";
import {
  openClimateServiceSyncConfigSchema,
  type OpenClimateServiceSyncConfig,
} from "./schemas/config.ts";

export type DatasetSyncOutcome = {
  datasetId: string;
  outcome: "up-to-date" | "synced" | "failed";
  action?: ClimateSyncAction;
  message: string;
  /** Last period the dataset covered before this step ran. */
  coveredUntil?: string | null;
  /** Period the sync brought the dataset up to, when it downloaded anything. */
  syncedUntil?: string | null;
  jobId?: string;
};

export type OpenClimateServiceSyncOutput = {
  datasets: DatasetSyncOutcome[];
  synced: number;
  upToDate: number;
  failed: number;
};

/**
 * Handler: open-climate-service-sync
 *
 * Brings Open Climate Service datasets up to date before a pipeline reads them, replacing the
 * manual monthly sync. Each dataset is its own task and runs alongside the others:
 *
 *   1. Ask the planner what a sync would do. Nothing to download → done, no job started.
 *   2. Otherwise queue the sync and poll its job until it finishes.
 *
 * A failed dataset fails the step unless `onFailure` is "continue", in which case later steps
 * run on the data already there.
 */
export const openClimateServiceSync: StepHandler = {
  async execute(ctx) {
    const parsed = openClimateServiceSyncConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      throw new Error(`Invalid open-climate-service-sync handlerConfig: ${parsed.error.message}`);
    }
    const config = parsed.data;

    await ctx.log("INFO", "Syncing climate datasets", {
      datasetIds: config.datasetIds,
      end: config.end ?? "latest",
      onFailure: config.onFailure,
    });

    const settled = await Promise.allSettled(
      config.datasetIds.map((datasetId) => syncDataset(ctx, datasetId, config))
    );

    const datasets = settled.map(
      (result, index): DatasetSyncOutcome =>
        result.status === "fulfilled"
          ? result.value
          : {
              datasetId: config.datasetIds[index]!,
              outcome: "failed",
              message:
                result.reason instanceof Error ? result.reason.message : String(result.reason),
            }
    );

    const output: OpenClimateServiceSyncOutput = {
      datasets,
      synced: datasets.filter((d) => d.outcome === "synced").length,
      upToDate: datasets.filter((d) => d.outcome === "up-to-date").length,
      failed: datasets.filter((d) => d.outcome === "failed").length,
    };

    if (output.failed > 0) {
      const failures = datasets
        .filter((d) => d.outcome === "failed")
        .map((d) => `${d.datasetId}: ${d.message}`)
        .join("; ");
      if (config.onFailure === "fail") {
        throw new Error(
          `${output.failed} of ${datasets.length} climate dataset(s) failed to sync — ${failures}`
        );
      }
      await ctx.log(
        "WARN",
        "Some climate datasets failed to sync; continuing with the data already available",
        { failures }
      );
    }

    await ctx.log("INFO", "Open Climate Service sync finished", {
      synced: output.synced,
      upToDate: output.upToDate,
      failed: output.failed,
    });
    return output;
  },
};

async function syncDataset(
  ctx: StepContext,
  datasetId: string,
  config: OpenClimateServiceSyncConfig
): Promise<DatasetSyncOutcome> {
  const task = await ctx.tasks.startTask(`sync:${datasetId}`, {
    datasetId,
    end: config.end ?? null,
  });

  try {
    const plan = await planClimateDatasetSync(datasetId, config.end);
    await task.log("INFO", "Sync plan", {
      action: plan.action,
      reason: plan.reason,
      message: plan.message,
      currentEnd: plan.current_end ?? null,
      targetEnd: plan.target_end ?? null,
    });

    if (!WORKING_SYNC_ACTIONS.has(plan.action)) {
      const outcome: DatasetSyncOutcome = {
        datasetId,
        outcome: "up-to-date",
        action: plan.action,
        message: plan.message,
        coveredUntil: plan.current_end ?? null,
      };
      if (plan.action === "not_syncable") {
        await task.log("WARN", "Dataset cannot be synced; using it as it is", {
          reason: plan.reason,
        });
      }
      await task.succeed(outcome);
      return outcome;
    }

    const started = await startClimateDatasetSync(datasetId, config.end);
    if (started.kind === "completed") {
      const outcome: DatasetSyncOutcome = {
        datasetId,
        outcome: "synced",
        action: plan.action,
        message: started.message ?? plan.message,
        coveredUntil: plan.current_end ?? null,
        syncedUntil: plan.target_end ?? null,
      };
      await task.succeed(outcome);
      return outcome;
    }

    await task.log("INFO", "Sync job queued", { jobId: started.jobId });
    await waitForJob(task, datasetId, started.jobId, config.polling);

    const outcome: DatasetSyncOutcome = {
      datasetId,
      outcome: "synced",
      action: plan.action,
      message: plan.message,
      coveredUntil: plan.current_end ?? null,
      syncedUntil: plan.target_end ?? null,
      jobId: started.jobId,
    };
    await task.succeed(outcome);
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await task.fail(error);
    throw error;
  }
}

async function waitForJob(
  task: TaskHandle,
  datasetId: string,
  jobId: string,
  polling: OpenClimateServiceSyncConfig["polling"]
): Promise<void> {
  const { pollIntervalMs, maxAttempts } = polling;
  let lastStatus: ClimateJobStatus | "unknown" = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    let job;
    try {
      job = await getClimateJob(jobId);
    } catch (err) {
      await task.log("WARN", "Could not fetch sync job status, will retry", {
        jobId,
        attempt,
        error: String(err),
      });
      continue;
    }

    if (job.status !== lastStatus) {
      await task.log("INFO", "Sync job status update", { jobId, status: job.status, attempt });
      lastStatus = job.status;
    }

    if (TERMINAL_CLIMATE_JOB_STATUSES.has(job.status)) {
      if (job.status === "successful") return;
      const detail = job.error?.message ? `: ${job.error.message}` : "";
      throw new Error(`Sync job ${jobId} for "${datasetId}" ended as ${job.status}${detail}`);
    }
  }

  throw new Error(
    `Sync job ${jobId} for "${datasetId}" did not finish within ` +
      `${(maxAttempts * pollIntervalMs) / 60_000} minutes (last status "${lastStatus}"). ` +
      `It keeps running in the Open Climate Service; retry this step once it has finished.`
  );
}

registerHandler(Handlers.OPEN_CLIMATE_SERVICE_SYNC, openClimateServiceSync);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
