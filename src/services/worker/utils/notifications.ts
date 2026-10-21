import { getDhis2ServerTimeZone, sendMessageConversation } from "@/services/worker/utils/dhis2.ts";
import { hasRecipients, readPipelineNotifications } from "@/shared/pipeline/notifications.ts";
import { logger } from "@/shared/utils";
import { env } from "@/shared/utils/env.ts";

const MAX_ERROR_LENGTH = 1_000;

function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Time zone notifications are written in: the DHIS2 server's, or UTC when it is unknown. */
export async function resolveNotificationTimeZone(): Promise<string> {
  const timeZone = await getDhis2ServerTimeZone();
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** Where DHIS2 serves the installed CAPS app (its app key is `caps-app`). */
const CAPS_APP_PATH = "api/apps/caps-app/index.html";

/** Link to a run's page in the CAPS app installed on DHIS2. */
export function runUrl(executionId: string): string {
  const base = env.DHIS2_BASE_URL.replace(/\/+$/, "");
  return `${base}/${CAPS_APP_PATH}#/executions/${encodeURIComponent(executionId)}`;
}

/** e.g. "20 Oct 2026, 13:08 (Africa/Nairobi)" */
export function formatNotificationDateTime(date: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${formatted} (${timeZone})`;
}

/** e.g. "2026-10-20", the calendar date in the given time zone. */
export function formatNotificationDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Sends the pipeline's on-failure DHIS2 message, if one is configured.
 * Best-effort: never throws, so a messaging problem cannot affect the run's status.
 */
export async function notifyPipelineFailure(args: {
  pipeline: { name: string; config: unknown };
  executionId: string;
  stepName?: string;
  errorMessage?: string;
}): Promise<void> {
  const recipients = readPipelineNotifications(args.pipeline.config).onFailure;
  if (!recipients || !hasRecipients(recipients)) {
    return;
  }

  const timeZone = await resolveNotificationTimeZone();
  const error = args.errorMessage?.trim();
  const lines = [
    args.stepName
      ? `The CAPS pipeline "${args.pipeline.name}" failed at step "${args.stepName}".`
      : `The CAPS pipeline "${args.pipeline.name}" failed.`,
    "",
    `Time: ${formatNotificationDateTime(new Date(), timeZone)}`,
  ];
  if (error) {
    lines.push("", `Error: ${error.slice(0, MAX_ERROR_LENGTH)}`);
  }
  lines.push("", "View the run and its logs in CAPS:", runUrl(args.executionId));

  try {
    await sendMessageConversation({
      subject: `CAPS: pipeline "${args.pipeline.name}" failed`,
      text: lines.join("\n"),
      users: recipients.users,
      userGroups: recipients.userGroups,
    });
    logger.info(`[notifications] Failure notification sent executionId=${args.executionId}`);
  } catch (err) {
    logger.warn(
      `[notifications] Failed to send failure notification executionId=${args.executionId} error="${String(err)}"`
    );
  }
}
