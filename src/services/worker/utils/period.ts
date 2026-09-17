import { createFixedPeriodFromPeriodId } from "@dhis2/multi-calendar-dates";

export type ClimatePeriodConfig = {
  periodType: "daily" | "weekly" | "monthly";
  id: string;
  endId?: string;
};

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function temporalExtentFromPeriod(period: ClimatePeriodConfig): [string, string] {
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

export function openEoPeriodTypeFromConfig(
  periodType: ClimatePeriodConfig["periodType"]
): "day" | "week" | "month" {
  switch (periodType) {
    case "daily":
      return "day";
    case "weekly":
      return "week";
    case "monthly":
      return "month";
  }
}
