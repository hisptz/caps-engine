export const CALCULATION_METHOD_VALUES = [
  "mean",
  "SD",
  "median",
  "mean + 2SD",
  "mean + SD",
  "C-SUM",
  "C-SUM SD",
  "C-SUM + 1.96SD",
  "75th percentile",
  "25th percentile",
] as const;

export type CalculationMethod = (typeof CALCULATION_METHOD_VALUES)[number];

export const CSUM_CALCULATION_METHODS = ["C-SUM", "C-SUM SD", "C-SUM + 1.96SD"] as const;

export type CsumCalculationMethod = (typeof CSUM_CALCULATION_METHODS)[number];

export function isCsumCalculationMethod(
  method: CalculationMethod
): method is CsumCalculationMethod {
  return (CSUM_CALCULATION_METHODS as readonly string[]).includes(method);
}

export type CalculateThresholdOptions = {
  /** Pooled prev/current/next sub-period values across historical years (C-SUM family). */
  windowValues?: number[];
};

/** Arithmetic mean. Returns NaN for empty input. */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation. Returns NaN for empty input, 0 for a single value. */
export function standardDeviation(values: number[]): number {
  if (values.length === 0) return NaN;
  if (values.length === 1) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Median. Returns NaN for empty input. Sorts a copy — does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Quantile with linear interpolation (Hyndman type 7, R default).
 * For exactly five baseline years, p=0.75 matches WHO's second-highest value.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p + 1;
  const j = Math.floor(h);
  const gamma = h - j;
  const lower = sorted[j - 1]!;
  const upper = sorted[Math.min(j, sorted.length - 1)]!;
  return (1 - gamma) * lower + gamma * upper;
}

/** WHO C-SUM baseline: mean of pooled three-period window values across historical years. */
export function cSumMean(windowValues: number[]): number {
  return mean(windowValues);
}

/** Population SD of the same pooled window values used for C-SUM. */
export function cSumStandardDeviation(windowValues: number[]): number {
  return standardDeviation(windowValues);
}

/** WHO C-SUM upper 95% limit: mean + 1.96 × population SD of pooled window values. */
export function cSumPlus196Sd(windowValues: number[]): number {
  if (windowValues.length === 0) return NaN;
  return cSumMean(windowValues) + 1.96 * cSumStandardDeviation(windowValues);
}

/** Apply the selected calculation method to historical values. Returns NaN for empty input. */
export function calculateThreshold(
  method: CalculationMethod,
  values: number[],
  options?: CalculateThresholdOptions
): number {
  switch (method) {
    case "mean":
      return mean(values);
    case "SD":
      return standardDeviation(values);
    case "median":
      return median(values);
    case "mean + SD":
      return mean(values) + standardDeviation(values);
    case "mean + 2SD":
      return mean(values) + 2 * standardDeviation(values);
    case "75th percentile":
      return quantile(values, 0.75);
    case "25th percentile":
      return quantile(values, 0.25);
    case "C-SUM": {
      const window = options?.windowValues;
      if (window === undefined || window.length === 0) return NaN;
      return cSumMean(window);
    }
    case "C-SUM SD": {
      const window = options?.windowValues;
      if (window === undefined || window.length === 0) return NaN;
      return cSumStandardDeviation(window);
    }
    case "C-SUM + 1.96SD": {
      const window = options?.windowValues;
      if (window === undefined || window.length === 0) return NaN;
      return cSumPlus196Sd(window);
    }
  }
}
