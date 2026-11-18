import {
  StepPermanentError,
  StepWaitingError,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { temporalExtentFromPeriod } from "@/services/worker/utils/period.ts";
import {
  FINAL_OCS_RUN_STATUSES,
  getOcsDatasetPeriodType,
  getOcsPipeline,
  getOcsPipelineRun,
  startOcsPipelineRun,
  type OcsPipelineRun,
} from "@/shared/clients/ocsPipelines.ts";
import { ocsPipelineRunConfigSchema } from "./schemas/config.ts";

/** Carried between checks of the same attempt (see StepWaitingError). */
type WaitState = {
  runId?: string;
  start?: string;
  end?: string;
  lastStatus?: string;
  checks?: number;
  statusErrors?: number;
};

/** How often the run is checked, and how long it may take before the step gives up. */
const polling = { intervalSeconds: 15, timeoutHours: 6 };

/** Consecutive failed status reads tolerated before the step fails (OCS restarting, say). */
const MAX_STATUS_ERRORS = 10;

/** The period types a step's period can have (`climatePeriodSchema`). */
const STEP_PERIOD_TYPES = new Set(["daily", "weekly", "monthly"]);

export type OcsPipelineRunOutput = {
  pipelineId: string;
  runId: string;
  status: string;
  mode: "live" | "dry_run";
  start: string;
  end: string;
  deliveryResult: string | null;
  submitted: number;
  conflicts: number;
};

/**
 * Handler: ocs-pipeline-run
 *
 * Runs an Open Climate Service pipeline (`POST /pipelines/{id}/runs`) over the step's period,
 * then checks the run until it is final. OCS renders the workflow and delivers the values to
 * DHIS2 through the pipeline's destination; CAPS only decides when, and over which interval.
 *
 * - First check: reads the pipeline, refuses a live run of a pipeline that is not live (OCS
 *   would refuse it too, with less to go on), warns when OCS also starts it by itself
 *   (policy `on_update`), and starts the run.
 * - Later checks: `succeeded` returns the delivery counts; `failed`, `canceled` and
 *   `needs_attention` (delivery failed, or DHIS2's answer was partial or a rejection) fail the
 *   step without retries, since running it again would not change OCS's answer; anything else
 *   keeps waiting, with nothing held between checks.
 */
export const ocsPipelineRun: StepHandler = {
  async execute(ctx) {
    const config = ocsPipelineRunConfigSchema.parse(ctx.handlerConfig ?? {});
    const { pipelineId, mode } = config;
    const state = (ctx.waitState ?? {}) as WaitState;

    if (!state.runId) {
      const [start, end] = temporalExtentFromPeriod(config.period);
      const pipeline = await getOcsPipeline(pipelineId);
      if (mode === "live" && pipeline.spec.delivery.mode !== "live") {
        throw new StepPermanentError(
          `OCS pipeline "${pipelineId}" is in ${pipeline.spec.delivery.mode} mode. Dry-run it and switch it to live, or set this step to dry run.`
        );
      }
      const datasetId = pipeline.inputs.find((input) => input.kind === "dataset")?.id;
      if (datasetId) {
        // OCS delivers at the dataset's own period type; a window in another unit would cut
        // its periods short (shorter) or wrongly suggest it aggregates them (longer).
        const datasetPeriodType = await getOcsDatasetPeriodType(datasetId);
        if (datasetPeriodType && datasetPeriodType !== config.period.periodType) {
          const fix = STEP_PERIOD_TYPES.has(datasetPeriodType)
            ? `Set the step's period type to ${datasetPeriodType}.`
            : "This step runs daily, weekly and monthly datasets only.";
          throw new StepPermanentError(
            `OCS pipeline "${pipelineId}" delivers ${datasetPeriodType} values (dataset "${datasetId}"), but this step's period is ${config.period.periodType}. ${fix}`
          );
        }
      }
      if (pipeline.trigger.policy !== "manual") {
        await ctx.log(
          "WARN",
          "OCS also starts this pipeline on dataset updates; set its policy to manual so values are not delivered twice",
          { pipelineId, policy: pipeline.trigger.policy }
        );
      }

      const startTask = await ctx.tasks.startTask("start-ocs-pipeline-run", {
        pipelineId,
        start,
        end,
        mode,
      });
      let run: OcsPipelineRun;
      try {
        run = await startOcsPipelineRun(pipelineId, { start, end, mode });
        await startTask.succeed({ runId: run.run_id, status: run.status });
      } catch (error) {
        await startTask.fail(error as Error);
        throw error;
      }
      await ctx.log("INFO", "OCS pipeline run started", {
        pipelineId,
        runId: run.run_id,
        start,
        end,
        mode,
        intervalSeconds: polling.intervalSeconds,
      });
      return settleOrWait(run, { pipelineId, mode, start, end, checks: 1, statusErrors: 0 });
    }

    const since = ctx.stepExecution.startedAt ?? new Date();
    const waitedMs = Date.now() - since.getTime();
    if (waitedMs > polling.timeoutHours * 3_600_000) {
      throw new StepPermanentError(
        `OCS pipeline run ${state.runId} was not final after ${polling.timeoutHours} h (last status: ${state.lastStatus ?? "unknown"})`
      );
    }

    let run: OcsPipelineRun;
    try {
      run = await getOcsPipelineRun(pipelineId, state.runId);
    } catch (error) {
      const statusErrors = (state.statusErrors ?? 0) + 1;
      if (statusErrors >= MAX_STATUS_ERRORS) {
        throw new Error(
          `Could not read OCS pipeline run ${state.runId} ${statusErrors} times in a row: ${String(error)}`,
          { cause: error }
        );
      }
      await ctx.log("WARN", "Could not read the OCS pipeline run, will check again", {
        runId: state.runId,
        error: String(error),
      });
      throw new StepWaitingError("OCS run status not available", {
        retryAfterMs: polling.intervalSeconds * 1000,
        state: { ...state, statusErrors, checks: (state.checks ?? 0) + 1 },
      });
    }

    if (run.status !== state.lastStatus) {
      await ctx.log("INFO", "OCS pipeline run status", { runId: run.run_id, status: run.status });
    }
    return settleOrWait(run, {
      pipelineId,
      mode,
      start: state.start ?? run.start,
      end: state.end ?? run.end,
      checks: (state.checks ?? 0) + 1,
      statusErrors: 0,
    });

    async function settleOrWait(
      current: OcsPipelineRun,
      info: {
        pipelineId: string;
        mode: "live" | "dry_run";
        start: string;
        end: string;
        checks: number;
        statusErrors: number;
      }
    ): Promise<OcsPipelineRunOutput> {
      if (!FINAL_OCS_RUN_STATUSES.has(current.status)) {
        throw new StepWaitingError(`OCS run ${current.status}`, {
          retryAfterMs: polling.intervalSeconds * 1000,
          state: {
            runId: current.run_id,
            start: info.start,
            end: info.end,
            lastStatus: current.status,
            checks: info.checks,
            statusErrors: info.statusErrors,
          },
        });
      }
      if (current.status !== "succeeded") {
        const reason =
          current.failure?.message ?? current.error ?? current.delivery_result ?? current.status;
        throw new StepPermanentError(
          `OCS pipeline run ${current.run_id} ended ${current.status.replace("_", " ")}: ${reason}`
        );
      }
      const submitted = current.delivery_submitted ?? 0;
      if (submitted === 0) {
        // OCS calls an empty delivery a success; it usually means the areas lie outside the
        // dataset's coverage, or the dataset has no data for the period.
        await ctx.log(
          "WARN",
          "The OCS run succeeded but sent no values to DHIS2. Check that the dataset covers the pipeline's areas and has data for the period.",
          { pipelineId: info.pipelineId, runId: current.run_id, start: info.start, end: info.end }
        );
      }
      return {
        pipelineId: info.pipelineId,
        runId: current.run_id,
        status: current.status,
        mode: info.mode,
        start: info.start,
        end: info.end,
        deliveryResult: current.delivery_result ?? null,
        submitted,
        conflicts: current.delivery_conflicts ?? 0,
      };
    }
  },
};
