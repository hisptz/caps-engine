import {
  registerHandler,
  type StepContext,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { sendMessageConversation } from "@/services/worker/utils/dhis2.ts";
import {
  formatNotificationDate,
  resolveNotificationTimeZone,
} from "@/services/worker/utils/notifications.ts";
import { dhis2NotifyConfigSchema } from "@/services/worker/services/handlers/dhis2Notify/schemas/config.ts";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Handler: dhis2-notify
 *
 * Sends a DHIS2 message to the configured users / user groups. Placed after any step
 * (e.g. Prediction Poll for "prediction is ready", DHIS2 Data Upload for "data is in DHIS2").
 *
 * The previous step's output is passed through unchanged, so the step can sit in the
 * middle of a pipeline without breaking the steps after it.
 */
export const dhis2Notify: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2NotifyConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-notify handlerConfig: ${parsed.error.message}`);
    }
    const { recipients, subject, message, failOnError } = parsed.data;

    const variables = buildTemplateVariables(ctx, await resolveNotificationTimeZone());
    const missing = new Set<string>();
    const rendered = {
      subject: renderTemplate(subject, variables, missing),
      text: renderTemplate(message, variables, missing),
    };
    if (missing.size > 0) {
      await ctx.log("WARN", "dhis2-notify: placeholders without a value were left empty", {
        placeholders: [...missing],
      });
    }

    const task = await ctx.tasks.startTask("send-dhis2-message", {
      users: recipients.users,
      userGroups: recipients.userGroups,
      subject: rendered.subject,
    });

    try {
      await sendMessageConversation({
        ...rendered,
        users: recipients.users,
        userGroups: recipients.userGroups,
      });
      await task.succeed({ sent: true });
      await ctx.log("INFO", "DHIS2 notification sent", {
        users: recipients.users.length,
        userGroups: recipients.userGroups.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await task.fail(error);
      if (failOnError) {
        throw error;
      }
      await ctx.log("WARN", "DHIS2 notification failed; continuing (failOnError is false)", {
        error: error.message,
      });
    }

    return ctx.input;
  },
};

registerHandler(Handlers.DHIS2_NOTIFY, dhis2Notify);

function buildTemplateVariables(ctx: StepContext, timeZone: string): Record<string, unknown> {
  return {
    stepName: ctx.step.name,
    executionId: ctx.stepExecution.executionId,
    date: formatNotificationDate(new Date(), timeZone),
    input: ctx.input,
  };
}

export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  missing: Set<string> = new Set()
): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (acc, key) =>
          acc !== null && typeof acc === "object"
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        variables
      );
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    missing.add(path);
    return "";
  });
}
