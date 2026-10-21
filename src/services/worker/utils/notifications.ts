import { getDhis2ServerTimeZone, sendMessageConversation } from "@/services/worker/utils/dhis2.ts";
import { hasRecipients, readPipelineNotifications } from "@/shared/pipeline/notifications.ts";
import { logger } from "@/shared/utils";

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
    `Run: ${args.executionId}`,
    `Time: ${formatNotificationDateTime(new Date(), timeZone)}`,
  ];
  if (error) {
    lines.push("", `Error: ${error.slice(0, MAX_ERROR_LENGTH)}`);
  }

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
