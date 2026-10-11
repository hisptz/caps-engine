import { createFixedPeriodFromPeriodId } from "@dhis2/multi-calendar-dates";

export type ClimatePeriodConfig = {
  periodType: "daily" | "weekly" | "monthly";
  id?: string;
  endId?: string;
  lastDays?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function temporalExtentFromPeriod(
  period: ClimatePeriodConfig,
  now: Date = new Date()
): [string, string] {
  if (period.id === undefined) {
    if (period.lastDays === undefined) {
      throw new Error("A climate period needs either id or lastDays");
    }
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const end = today - DAY_MS;
    const start = end - (period.lastDays - 1) * DAY_MS;
    return [formatIsoDate(new Date(start)), formatIsoDate(new Date(end))];
  }
  const startPeriod = createFixedPeriodFromPeriodId({
    periodId: period.id,
    calendar: "iso8601",
  });
  const endPeriod = period.endId
    ? createFixedPeriodFromPeriodId({
        periodId: period.endId,
        calendar: "iso8601",
      })
    : startPeriod;

  return [
    formatIsoDate(new Date(startPeriod.startDate)),
    formatIsoDate(new Date(endPeriod.endDate)),
  ];
}
