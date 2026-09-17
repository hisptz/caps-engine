import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  getOpenEoJob,
  SUCCESS_OPENEO_JOB_STATUS,
  TERMINAL_OPENEO_JOB_STATUSES,
  type OpenEoJobStatus,
} from "@/shared/clients/openeo.ts";

const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 360;

/**
 * Handler: climate-openeo-poll
 *
 * Polls GET /jobs/{jobId} until the openEO job reaches a terminal state.
 * Succeeds when status is "finished"; throws on "error" or "canceled".
 *
 * Expected input (from climate-openeo-create): { jobId: string }
 *
 * Output (passed to climate-openeo-download): { jobId: string; status: string }
 */
export const climateOpenEoPoll: StepHandler = {
  async execute(ctx) {
    const input = ctx.input as { jobId?: string };
    const jobId = input?.jobId;

    if (!jobId) {
      throw new Error("climate-openeo-poll requires { jobId } from the previous step's output");
    }

    await ctx.log("INFO", "Starting poll for Open Climate Service job", { jobId });

    const pollTask = await ctx.tasks.startTask("poll-openeo-job", { jobId });

    let attempts = 0;
    let lastStatus: OpenEoJobStatus | "" = "";

    while (attempts < MAX_ATTEMPTS) {
      attempts++;

      let status: OpenEoJobStatus;
      try {
        const job = await getOpenEoJob(jobId);
        status = job.status;
      } catch (err) {
        await ctx.log("WARN", "Failed to fetch Open Climate Service job status, will retry", {
          jobId,
          attempt: attempts,
          error: String(err),
        });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (status !== lastStatus) {
        await ctx.log("INFO", "Open Climate Service job status update", {
          jobId,
          status,
          attempt: attempts,
        });
        lastStatus = status;
      }

      if (TERMINAL_OPENEO_JOB_STATUSES.has(status)) {
        if (status !== SUCCESS_OPENEO_JOB_STATUS) {
          let detail = `job ended with status "${status}"`;
          try {
            const job = await getOpenEoJob(jobId);
            if (job.logs) {
              detail = `${detail}: ${job.logs}`;
            }
          } catch {
            // ignore secondary fetch errors
          }
          const error = new Error(`Open Climate Service job ${jobId} ${detail}`);
          await pollTask.fail(error);
          throw error;
        }

        const result = { jobId, status };
        await pollTask.succeed(result);
        await ctx.log("INFO", "Open Climate Service job completed successfully", result);
        return result;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const timeoutError = new Error(
      `Open Climate Service job ${jobId} did not complete within ${MAX_ATTEMPTS} attempts (` +
        `${(MAX_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} minutes). Last status: "${lastStatus}"`
    );
    await pollTask.fail(timeoutError);
    throw timeoutError;
  },
};

registerHandler(Handlers.CLIMATE_OPENEO_POLL, climateOpenEoPoll);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
