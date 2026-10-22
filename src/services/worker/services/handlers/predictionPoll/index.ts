import {
  registerHandler,
  StepPermanentError,
  StepWaitingError,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { getJobDescription, getJobLogTail, getJobStatus } from "@/services/worker/utils/chap.ts";
import { predictionPollConfigSchema } from "./schemas/config.ts";

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

/** Carried between checks of the same attempt (see StepWaitingError). */
type WaitState = {
  jobId?: string;
  lastStatus?: string;
  checks?: number;
  statusErrors?: number;
};

function withLogTail(message: string, logTail: string | null): string {
  return logTail ? `${message}\n\nLast lines of the CHAP job log:\n${logTail}` : message;
}

/**
 * Handler: prediction-poll
 *
 * Waits for the CHAP job started by the preceding prediction-trigger step, checking
 * GET /v1/jobs/{job_id} every `polling.intervalSeconds` until CHAP reports a final state:
 * - SUCCESS: the step succeeds.
 * - FAILURE / REVOKED (and legacy failed / cancelled): the step fails without automatic
 *   retries, since re-reading a failed job cannot change it; the pipeline stops here.
 * - Anything else (PENDING, STARTED, …): the step keeps waiting. Each check is a short run;
 *   between checks nothing is held (StepWaitingError), so a model that trains for hours
 *   neither blocks the worker nor times out a broker delivery.
 * `polling.timeoutHours` is a safety net for a job CHAP leaves STARTED for good.
 *
 * Expected input (from the preceding prediction-trigger step):
 * { jobId: string; predictionSetupId?: number }
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
      throw new StepPermanentError(
        "prediction-poll requires { jobId } from the previous step's output"
      );
    }

    const { polling } = predictionPollConfigSchema.parse(ctx.handlerConfig ?? {});
    const state = (ctx.waitState ?? {}) as WaitState;
    const checks = (state.checks ?? 0) + 1;
    const since = ctx.stepExecution.startedAt ?? new Date();
    const waitedMs = Date.now() - since.getTime();
    const waitedMinutes = Math.round(waitedMs / 60_000);

    if (!ctx.waitState) {
      await ctx.log("INFO", "Waiting for CHAP prediction job", {
        jobId,
        intervalSeconds: polling.intervalSeconds,
        timeoutHours: polling.timeoutHours,
      });
    }

    let status: string | null = null;
    try {
      status = await getJobStatus(jobId);
    } catch (err) {
      // CHAP briefly unreachable: keep waiting within the deadline, and say so once.
      if (!state.statusErrors) {
        await ctx.log("WARN", "Could not read the CHAP job status; will keep checking", {
          jobId,
          error: String(err),
        });
      }
    }

    if (status !== null && status !== state.lastStatus) {
      await ctx.log("INFO", "CHAP job status", { jobId, status, waitedMinutes });
    }

    if (status === CHAP_SUCCESS_STATUS) {
      const description = await getJobDescription(jobId).catch(() => null);
      const result = {
        jobId,
        status,
        result: description?.result ?? null,
        predictionSetupId,
      };
      const task = await ctx.tasks.startTask("wait-for-prediction-job", {
        jobId,
        checks,
        waitedMinutes,
      });
      await task.succeed(result);
      await ctx.log("INFO", "CHAP prediction job completed successfully", result);
      return result;
    }

    if (status !== null && CHAP_TERMINAL_FAILURE_STATUSES.has(status)) {
      const description = await getJobDescription(jobId).catch(() => null);
      const detail = description?.result ?? `job ended with status "${status}"`;
      const error = new StepPermanentError(
        withLogTail(`CHAP prediction job ${jobId} ${status}: ${detail}`, await getJobLogTail(jobId))
      );
      const task = await ctx.tasks.startTask("wait-for-prediction-job", {
        jobId,
        checks,
        waitedMinutes,
      });
      await task.fail(error);
      throw error;
    }

    const lastStatus = status ?? state.lastStatus;
    if (waitedMs >= polling.timeoutHours * 3_600_000) {
      const error = new StepPermanentError(
        withLogTail(
          `CHAP prediction job ${jobId} is still "${lastStatus ?? "unknown"}" after ` +
            `${polling.timeoutHours} h (${checks} checks), so it may be stuck: check the CHAP ` +
            `worker and the model service. Raise polling.timeoutHours if the model needs longer.`,
          await getJobLogTail(jobId)
        )
      );
      const task = await ctx.tasks.startTask("wait-for-prediction-job", {
        jobId,
        checks,
        waitedMinutes,
      });
      await task.fail(error);
      throw error;
    }

    throw new StepWaitingError(`CHAP job ${lastStatus ?? "status not available yet"}`, {
      retryAfterMs: polling.intervalSeconds * 1000,
      state: {
        jobId,
        lastStatus,
        checks,
        statusErrors: status === null ? (state.statusErrors ?? 0) + 1 : 0,
        waitedMinutes,
      } satisfies WaitState & { waitedMinutes: number },
    });
  },
};

registerHandler(Handlers.PREDICTION_POLL, predictionPoll);
