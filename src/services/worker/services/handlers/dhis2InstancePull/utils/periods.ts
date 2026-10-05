import { DateTime } from "luxon";
import type { PullPeriod, PullPeriodType } from "../schemas/config.ts";

const UNIT = { MONTHLY: "month", WEEKLY: "week" } as const;
const DURATION = { MONTHLY: "months", WEEKLY: "weeks" } as const;

/** DHIS2 period ID for the period starting at `start` (weeks are ISO weeks, unpadded: 2026W5). */
export function toPeriodId(start: DateTime, periodType: PullPeriodType): string {
  return periodType === "MONTHLY"
    ? start.toFormat("yyyyMM")
    : `${start.weekYear}W${start.weekNumber}`;
}

/** Start of the period with this ID, in UTC. */
export function parsePeriodId(periodId: string, periodType: PullPeriodType): DateTime {
  const parsed =
    periodType === "MONTHLY"
      ? DateTime.fromFormat(periodId, "yyyyMM", { zone: "utc" })
      : (() => {
          const match = /^(\d{4})W(\d{1,2})$/.exec(periodId);
          return match
            ? DateTime.fromObject(
                { weekYear: Number(match[1]), weekNumber: Number(match[2]), weekday: 1 },
                { zone: "utc" }
              )
            : DateTime.invalid("not a weekly period ID");
        })();
  if (!parsed.isValid) {
    throw new Error(`"${periodId}" is not a valid ${periodType.toLowerCase()} period`);
  }
  return parsed.startOf(UNIT[periodType]);
}

/** End (exclusive) of the period with this ID. */
export function periodEnd(periodId: string, periodType: PullPeriodType): DateTime {
  return parsePeriodId(periodId, periodType).plus({ [DURATION[periodType]]: 1 });
}

/**
 * Period IDs a pull covers, oldest first.
 * - fixed: every period from `start` to `end`, inclusive.
 * - relative: `count` periods ending `offset` periods before the one `now` falls in.
 *   A run in 2026-09 with count 3 and offset 1 gives 202606, 202607, 202608.
 */
export function resolvePullPeriods(period: PullPeriod, now: DateTime = DateTime.utc()): string[] {
  const { periodType } = period;
  const unit = UNIT[periodType];
  const duration = DURATION[periodType];

  let first: DateTime;
  let last: DateTime;
  if (period.mode === "fixed") {
    first = parsePeriodId(period.start, periodType);
    last = parsePeriodId(period.end, periodType);
    if (last < first) {
      throw new Error(`Period range ends (${period.end}) before it starts (${period.start})`);
    }
  } else {
    last = now
      .toUTC()
      .startOf(unit)
      .minus({ [duration]: period.offset });
    first = last.minus({ [duration]: period.count - 1 });
  }

  const periods: string[] = [];
  for (let cursor = first; cursor <= last; cursor = cursor.plus({ [duration]: 1 })) {
    periods.push(toPeriodId(cursor, periodType));
  }
  return periods;
}
