import { PeriodUtility } from "@hisptz/dhis2-utils";

export type ThresholdPeriodType = "Monthly" | "Weekly" | "Quarterly" | "BiMonthly" | "SixMonthly";

/**
 * Returns the ISO date-time string for the start of a DHIS2 period ID.
 * Used as tracker event occurredAt (e.g. "2026-05-01T00:00:00.000").
 */
export function periodToOccurredAt(periodId: string): string {
  const { start } = PeriodUtility.getPeriodById(periodId);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${start.year}-${pad(start.month)}-${pad(start.day)}T00:00:00.000`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of ISO weeks in a year (52 or 53).
 * A year has 53 ISO weeks if Jan 1st is Thursday, or Jan 1st is Wednesday in a leap year.
 */
export function isoWeeksInYear(year: number): number {
  const jan1 = new Date(year, 0, 1).getDay(); // 0=Sun
  const isoJan1 = jan1 === 0 ? 7 : jan1; // Mon=1 … Sun=7
  if (isoJan1 === 4) return 53;
  if (isoJan1 === 3 && isLeapYear(year)) return 53;
  return 52;
}

/**
 * Generate all DHIS2 sub-period identifiers within a given year for the specified period type.
 *
 * Examples:
 *   generateSubPeriods(2023, "Monthly")    → ["202301", ..., "202312"]
 *   generateSubPeriods(2023, "Quarterly")  → ["2023Q1", ..., "2023Q4"]
 *   generateSubPeriods(2023, "BiMonthly")  → ["202301B", ..., "202306B"]
 *   generateSubPeriods(2023, "SixMonthly") → ["2023S1", "2023S2"]
 *   generateSubPeriods(2023, "Weekly")     → ["2023W01", ..., "2023W52"]
 */
export function generateSubPeriods(year: number, periodType: ThresholdPeriodType): string[] {
  switch (periodType) {
    case "Monthly":
      return Array.from({ length: 12 }, (_, i) => `${year}${String(i + 1).padStart(2, "0")}`);
    case "Quarterly":
      return [1, 2, 3, 4].map((q) => `${year}Q${q}`);
    case "BiMonthly":
      return Array.from({ length: 6 }, (_, i) => `${year}${String(i + 1).padStart(2, "0")}B`);
    case "SixMonthly":
      return [`${year}S1`, `${year}S2`];
    case "Weekly": {
      const weeks = isoWeeksInYear(year);
      return Array.from({ length: weeks }, (_, i) => `${year}W${String(i + 1).padStart(2, "0")}`);
    }
  }
}

/**
 * Return the equivalent sub-periods in the `count` years immediately preceding `targetYear`.
 *
 * Works for all DHIS2 period types by replacing the 4-digit year prefix:
 *   getHistoricalSubPeriods("202301",  2023, 3) → ["202201", "202101", "202001"]
 *   getHistoricalSubPeriods("2023Q2",  2023, 2) → ["2022Q2", "2021Q2"]
 *   getHistoricalSubPeriods("2023W05", 2023, 2) → ["2022W05", "2021W05"]
 *
 * Note: for weekly periods, if the historical year has fewer ISO weeks (52 vs 53) the
 * analytics API simply returns no data for that period — callers skip empty results.
 */
export function getHistoricalSubPeriods(
  subPeriod: string,
  targetYear: number,
  count: number
): string[] {
  const suffix = subPeriod.slice(4); // everything after the 4-digit year
  return Array.from({ length: count }, (_, i) => `${targetYear - (i + 1)}${suffix}`);
}

function parseSubPeriodIndex(subPeriod: string, periodType: ThresholdPeriodType): number {
  const suffix = subPeriod.slice(4);
  switch (periodType) {
    case "Monthly":
      return parseInt(suffix, 10) - 1;
    case "Quarterly":
      return parseInt(suffix.slice(1), 10) - 1;
    case "BiMonthly":
      return parseInt(suffix.slice(0, 2), 10) - 1;
    case "SixMonthly":
      return parseInt(suffix.slice(1), 10) - 1;
    case "Weekly":
      return parseInt(suffix.slice(1), 10) - 1;
  }
}

function formatSubPeriod(year: number, index: number, periodType: ThresholdPeriodType): string {
  switch (periodType) {
    case "Monthly":
      return `${year}${String(index + 1).padStart(2, "0")}`;
    case "Quarterly":
      return `${year}Q${index + 1}`;
    case "BiMonthly":
      return `${year}${String(index + 1).padStart(2, "0")}B`;
    case "SixMonthly":
      return `${year}S${index + 1}`;
    case "Weekly":
      return `${year}W${String(index + 1).padStart(2, "0")}`;
  }
}

function subPeriodCount(year: number, periodType: ThresholdPeriodType): number {
  switch (periodType) {
    case "Monthly":
      return 12;
    case "Quarterly":
      return 4;
    case "BiMonthly":
      return 6;
    case "SixMonthly":
      return 2;
    case "Weekly":
      return isoWeeksInYear(year);
  }
}

/**
 * Returns [previous, current, next] DHIS2 sub-period IDs for WHO C-SUM smoothing.
 * Crosses calendar years at boundaries (e.g. Jan → prior December).
 */
export function getSubPeriodWindow(
  subPeriod: string,
  periodType: ThresholdPeriodType
): [string, string, string] {
  const year = parseInt(subPeriod.slice(0, 4), 10);
  const index = parseSubPeriodIndex(subPeriod, periodType);
  const count = subPeriodCount(year, periodType);

  let prevYear = year;
  let prevIndex = index - 1;
  if (prevIndex < 0) {
    prevYear = year - 1;
    prevIndex = subPeriodCount(prevYear, periodType) - 1;
  }

  let nextYear = year;
  let nextIndex = index + 1;
  if (nextIndex >= count) {
    nextYear = year + 1;
    nextIndex = 0;
  }

  return [
    formatSubPeriod(prevYear, prevIndex, periodType),
    subPeriod,
    formatSubPeriod(nextYear, nextIndex, periodType),
  ];
}

/**
 * All period IDs needed for C-SUM: prev/current/next for each of `count` years before targetYear.
 */
export function getHistoricalWindowPeriods(
  subPeriod: string,
  targetYear: number,
  count: number
): string[] {
  const periodType = inferPeriodType(subPeriod);
  const periods = new Set<string>();
  for (let i = 1; i <= count; i++) {
    const historicalSubPeriod = `${targetYear - i}${subPeriod.slice(4)}`;
    for (const p of getSubPeriodWindow(historicalSubPeriod, periodType)) {
      periods.add(p);
    }
  }
  return [...periods];
}

function inferPeriodType(subPeriod: string): ThresholdPeriodType {
  const suffix = subPeriod.slice(4);
  if (/^W\d{2}$/.test(suffix)) return "Weekly";
  if (/^Q\d$/.test(suffix)) return "Quarterly";
  if (/^\d{2}B$/.test(suffix)) return "BiMonthly";
  if (/^S\d$/.test(suffix)) return "SixMonthly";
  return "Monthly";
}
