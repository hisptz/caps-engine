import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  getTaskMapByJobType,
  getTaskNotifications,
  isTaskCompleted,
  selectLatestIncompleteJobId,
  selectRunningJobId,
  triggerAnalyticsTablesRun,
  type DhisTaskNotification,
} from "@/services/worker/utils/dhis2.ts";
import {
  type Dhis2AnalyticsRunConfig,
  dhis2AnalyticsRunConfigSchema,
} from "@/services/worker/services/handlers/dhis2AnalyticsRun/schemas/config.ts";

const ANALYTICS_JOB_TYPE = "ANALYTICS_TABLE" as const;

type HandlerOutput = {
  jobId: string | null;
  triggered: boolean;
  attempts: number;
  assumedCompleted?: boolean;
};

export const dhis2AnalyticsRun: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2AnalyticsRunConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-analytics-run handlerConfig: ${parsed.error.message}`);
    }
    const config: Dhis2AnalyticsRunConfig = parsed.data;

    const jobType = ANALYTICS_JOB_TYPE;
    const { runOptions, polling } = config;
    const { pollIntervalMs, maxAttempts } = polling;

    await ctx.log("INFO", "Starting DHIS2 analytics tables run", {
      jobType,
      runOptions,
      pollIntervalMs,
      maxAttempts,
    });

    const task = await ctx.tasks.startTask("dhis2-analytics-run", {
      jobType,
      runOptions,
      pollIntervalMs,
      maxAttempts,
    });

    let triggered = false;

    // ----------------------------------------------------------
    // Preflight: if analytics is already running, skip trigger.
    // ----------------------------------------------------------
    const preflightTasks = await getTaskMapByJobType({ jobType, ctx });
    const runningJobId = selectRunningJobId({
      tasks: preflightTasks,
      nowMs: Date.now(),
      lookbackMs: 60 * 60 * 1000,
    });
    let jobId: string | null = runningJobId;
    if (jobId) {
      await ctx.log("INFO", "DHIS2 analytics already running (auto-detected)", { jobType, jobId });
    }

    // ----------------------------------------------------------
    // Trigger if not already running.
    // ----------------------------------------------------------
    if (!jobId) {
      await ctx.log("INFO", "Triggering DHIS2 analytics tables run", { jobType, runOptions });
      const triggerResponse = await triggerAnalyticsTablesRun({ options: runOptions, ctx });
      triggered = true;
      jobId = triggerResponse.response?.id ?? null;
      await ctx.log("INFO", "DHIS2 analytics tables run triggered", {
        jobType,
        jobId,
        triggerStatus: triggerResponse.status,
      });
    }

    // ----------------------------------------------------------
    // Poll for completion.
    // If jobId is unknown after trigger, auto-detect it first.
    // ----------------------------------------------------------
    await ctx.log("INFO", "Polling DHIS2 analytics job status", {
      jobType,
      jobId,
      pollIntervalMs,
      maxAttempts,
    });

    let attempts = 0;
    let lastStatus: "RUNNING" | "SUCCESS" | "ERROR" | "CANCELLED" | "UNKNOWN" = "UNKNOWN";

    while (attempts < maxAttempts) {
      attempts++;

      try {
        if (!jobId) {
          await ctx.log("INFO", "DHIS2 analytics poll: no jobId yet, searching task list", {
            attempt: attempts,
            maxAttempts,
          });
          const tasks = await getTaskMapByJobType({ jobType, ctx });
          jobId = selectLatestIncompleteJobId({ tasks });
          if (jobId) {
            await ctx.log("INFO", "Detected DHIS2 analytics jobId after trigger", {
              jobType,
              jobId,
              attempt: attempts,
            });
          } else {
            const result: HandlerOutput = {
              jobId: null,
              triggered,
              attempts,
              assumedCompleted: true,
            };
            await task.succeed(result);
            await ctx.log(
              "INFO",
              "No incomplete DHIS2 analytics jobs detected; assuming analytics completed",
              result
            );
            return result;
          }
        }

        const notifications = await getTaskNotifications({ jobType, jobId, ctx });
        const latestNotification = summarizeNotification(pickLatestNotification(notifications));

        await ctx.log("INFO", "DHIS2 analytics poll status", {
          attempt: attempts,
          maxAttempts,
          jobId,
          notificationCount: notifications.length,
          latestNotification,
        });

        const hasError = notifications.some((n) => n.level === "ERROR");
        const completed = isTaskCompleted(notifications);

        if (hasError) {
          lastStatus = "ERROR";
          const msg = notifications
            .filter((n) => n.level === "ERROR")
            .map((n) => n.message)
            .filter((m): m is string => typeof m === "string" && m.length > 0)
            .join("; ");
          const error = new Error(
            `DHIS2 analytics job ${jobId} reported ERROR${msg ? `: ${msg}` : ""}`
          );
          await task.fail(error);
          throw error;
        }

        if (completed) {
          lastStatus = "SUCCESS";
          const result: HandlerOutput = {
            jobId,
            triggered,
            attempts,
          };
          await task.succeed(result);
          await ctx.log("INFO", "DHIS2 analytics job completed successfully", result);
          return result;
        }

        lastStatus = "RUNNING";
        await sleep(pollIntervalMs);
      } catch (err) {
        await ctx.log("WARN", "Failed to poll DHIS2 analytics status, will retry", {
          jobType,
          jobId,
          attempt: attempts,
          error: String(err),
        });
        await sleep(pollIntervalMs);
      }
    }

    const timeoutError = new Error(
      `DHIS2 analytics job ${jobId ?? "(unknown)"} did not complete within ${maxAttempts} attempts ` +
        `(${(maxAttempts * pollIntervalMs) / 60_000} minutes). Last status: "${lastStatus}"`
    );
    await task.fail(timeoutError);
    throw timeoutError;
  },
};

registerHandler(Handlers.DHIS2_ANALYTICS_RUN, dhis2AnalyticsRun);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickLatestNotification(
  notifications: DhisTaskNotification[]
): DhisTaskNotification | null {
  let best: DhisTaskNotification | null = null;
  let bestMs: number | null = null;
  for (const n of notifications) {
    if (!n.time) continue;
    const t = Date.parse(n.time);
    if (Number.isNaN(t)) continue;
    if (bestMs === null || t > bestMs) {
      bestMs = t;
      best = n;
    }
  }
  if (best) return best;
  return notifications.length > 0 ? (notifications[notifications.length - 1] ?? null) : null;
}

function summarizeNotification(notification: DhisTaskNotification | null): {
  level?: string;
  message?: string;
  time?: string;
  completed?: boolean;
} | null {
  if (!notification) return null;
  return {
    level: notification.level,
    message: notification.message,
    time: notification.time,
    completed: notification.completed,
  };
}
