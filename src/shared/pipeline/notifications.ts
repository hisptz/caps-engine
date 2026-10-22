import { z } from "zod";

const DHIS2_UID = /^[a-zA-Z][a-zA-Z0-9]{10}$/;
const uid = z.string().regex(DHIS2_UID, "Must be a valid DHIS2 UID");

/** DHIS2 users / user groups that receive a DHIS2 message. */
export const dhis2RecipientsSchema = z.object({
  users: z.array(uid).default([]),
  userGroups: z.array(uid).default([]),
});

export type Dhis2Recipients = z.infer<typeof dhis2RecipientsSchema>;

export function hasRecipients(recipients: Dhis2Recipients): boolean {
  return recipients.users.length + recipients.userGroups.length > 0;
}

/**
 * Pipeline-level notifications, stored at `pipeline.config.notifications`.
 * Success notifications are a pipeline step (`dhis2-notify`); failures are sent by the
 * coordinator because no step runs after a failed one.
 */
export const pipelineNotificationsSchema = z.object({
  onFailure: dhis2RecipientsSchema.optional(),
});

export type PipelineNotifications = z.infer<typeof pipelineNotificationsSchema>;

/** Validates `notifications` when present and keeps any other config keys untouched. */
export const pipelineConfigSchema = z.looseObject({
  notifications: pipelineNotificationsSchema.optional(),
});

/** Reads notification settings from a stored pipeline config; invalid settings read as none. */
export function readPipelineNotifications(config: unknown): PipelineNotifications {
  const raw = (config as { notifications?: unknown } | null)?.notifications;
  const parsed = pipelineNotificationsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
