import { createFixedPeriodFromPeriodId } from "@dhis2/multi-calendar-dates";
import { DateTime } from "luxon";

export type ClimatePeriodType = "daily" | "weekly" | "monthly";

/** `id` to `endId` (or just `id`), as DHIS2 period IDs. */
export type FixedClimatePeriod = {
  mode?: "fixed";
  periodType: ClimatePeriodType;
  id: string;
  endId?: string;
};

/** `count` whole periods ending `offset` periods before the one the run falls in (UTC). */
export type RollingClimatePeriod = {
  mode: "rolling";
  periodType: ClimatePeriodType;
  count: number;
  offset?: number;
};

/** Earlier rolling form, kept for configs written before `mode`: daily, ending yesterday. */
export type LastDaysClimatePeriod = {
  periodType: "daily";
  lastDays: number;
};

export type ClimatePeriodConfig = FixedClimatePeriod | RollingClimatePeriod | LastDaysClimatePeriod;

/** Periods skipped before a rolling window ends, by default: the current, incomplete one. */
export const DEFAULT_ROLLING_OFFSET = 1;

const UNIT = { daily: "day", weekly: "week", monthly: "month" } as const;
const DURATION = { daily: "days", weekly: "weeks", monthly: "months" } as const;

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The rolling form of a period, or null for a fixed one. `lastDays` reads as daily rolling. */
export function rollingPeriodOf(period: ClimatePeriodConfig): RollingClimatePeriod | null {
  if ("lastDays" in period) {
    return {
      mode: "rolling",
      periodType: "daily",
      count: period.lastDays,
      offset: DEFAULT_ROLLING_OFFSET,
    };
  }
  return period.mode === "rolling" ? period : null;
}

/**
 * First and last day a period covers, inclusive. A rolling window is worked out from `now` and
 * aligned to whole periods (ISO weeks start on Monday), so a monthly window never starts or
 * ends mid-month.
 */
export function temporalExtentFromPeriod(
  period: ClimatePeriodConfig,
  now: Date = new Date()
): [string, string] {
  const rolling = rollingPeriodOf(period);
  if (rolling) {
    const unit = UNIT[rolling.periodType];
    const duration = DURATION[rolling.periodType];
    const offset = rolling.offset ?? DEFAULT_ROLLING_OFFSET;
    const last = DateTime.fromJSDate(now, { zone: "utc" })
      .startOf(unit)
      .minus({ [duration]: offset });
    const first = last.minus({ [duration]: rolling.count - 1 });
    const end = last.plus({ [duration]: 1 }).minus({ days: 1 });
    return [first.toISODate()!, end.toISODate()!];
  }

  const fixed = period as FixedClimatePeriod;
  const startPeriod = createFixedPeriodFromPeriodId({
    periodId: fixed.id,
    calendar: "iso8601",
  });
  const endPeriod = fixed.endId
    ? createFixedPeriodFromPeriodId({
        periodId: fixed.endId,
        calendar: "iso8601",
      })
    : startPeriod;

  return [
    formatIsoDate(new Date(startPeriod.startDate)),
    formatIsoDate(new Date(endPeriod.endDate)),
  ];
}

export function openEoPeriodTypeFromConfig(
  periodType: ClimatePeriodType
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
