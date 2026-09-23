import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { getJobDescription, getJobStatus } from "@/services/worker/utils/chap.ts";

export const CHAP_SUCCESS_STATUS = "SUCCESS";
export const CHAP_TERMINAL_FAILURE_STATUSES = new Set([
  "FAILURE",
  "failed",
  "REVOKED",
  "cancelled",
]);
export const CHAP_TERMINAL_STATUSES = new Set([
  CHAP_SUCCESS_STATUS,
  ...CHAP_TERMINAL_FAILURE_STATUSES,
]);

/** Milliseconds to wait between poll attempts */
const POLL_INTERVAL_MS = 5_000;
/** Maximum number of poll attempts before giving up (~10 minutes) */
const MAX_ATTEMPTS = 120;

/**
 * Handler: prediction-poll
 *
 * Polls CHAP's GET /v1/jobs/{job_id} until the job reaches a terminal state.
 * Succeeds when status is "SUCCESS"; throws on FAILURE / REVOKED and legacy failed / cancelled.
 *
 * Expected input (from the preceding prediction-trigger step):
 * { jobId: string }
 *
 * Output:
 * { jobId: string; status: string; result: string | null; predictionSetupId: number | null }
 */
export const predictionPoll: StepHandler = {
  async execute(ctx) {
    const input = ctx.input as { jobId?: string; predictionSetupId?: number };
    const jobId = input?.jobId;
    const predictionSetupId = input?.predictionSetupId ?? null;

    if (!jobId) {
      throw new Error("prediction-poll requires { jobId } from the previous step's output");
    }

    await ctx.log("INFO", "Starting poll for CHAP prediction job", { jobId });

    const task = await ctx.tasks.startTask("poll-prediction-job", { jobId });

    let attempts = 0;
    let lastStatus = "";

    while (attempts < MAX_ATTEMPTS) {
      attempts++;

      let status: string;
      try {
        status = await getJobStatus(jobId);
      } catch (err) {
        await ctx.log("WARN", "Failed to fetch job status, will retry", {
          jobId,
          attempt: attempts,
          error: String(err),
        });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (status !== lastStatus) {
        await ctx.log("INFO", "CHAP job status update", {
          jobId,
          status,
          attempt: attempts,
        });
        lastStatus = status;
      }

      if (CHAP_TERMINAL_STATUSES.has(status)) {
        if (status !== CHAP_SUCCESS_STATUS) {
          const description = await getJobDescription(jobId).catch(() => null);
          const errorDetail = description?.result ?? `job ended with status "${status}"`;
          const error = new Error(`CHAP prediction job ${jobId} ${status}: ${errorDetail}`);
          await task.fail(error);
          throw error;
        }

        const description = await getJobDescription(jobId).catch(() => null);
        const result = {
          jobId,
          status,
          result: description?.result ?? null,
          predictionSetupId,
        };
        await task.succeed(result);
        await ctx.log("INFO", "CHAP prediction job completed successfully", result);
        return result;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const timeoutError = new Error(
      `CHAP prediction job ${jobId} did not complete within ${MAX_ATTEMPTS} attempts (` +
        `${(MAX_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} minutes). Last status: "${lastStatus}"`
    );
    await task.fail(timeoutError);
    throw timeoutError;
  },
};

registerHandler(Handlers.PREDICTION_POLL, predictionPoll);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
