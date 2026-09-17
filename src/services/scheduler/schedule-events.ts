import { z } from "zod";

export const SCHEDULE_EVENTS_CHANNEL = "caps_schedule_events";

export const scheduleEventSchema = z.object({
  table: z.enum(["pipeline_schedules", "pipelines"]),
  op: z.enum(["INSERT", "UPDATE", "DELETE"]),
  id: z.uuid(),
});

export type ScheduleEvent = z.infer<typeof scheduleEventSchema>;

export function parseScheduleEvent(payload: string): ScheduleEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = scheduleEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export type ScheduleEventSubscription = {
  unlisten: () => Promise<void>;
};

export type ScheduleEventListen = (
  channel: string,
  onNotify: (payload: string) => void,
  onConnect?: () => void | Promise<void>
) => Promise<ScheduleEventSubscription>;
