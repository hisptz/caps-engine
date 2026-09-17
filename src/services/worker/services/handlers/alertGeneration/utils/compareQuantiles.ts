export type CompareInput = { threshold: number; quantileValues: number[] };

export type CompareResult = { alert: false } | { alert: true; triggeringValue: number };

/**
 * Returns whether any quantile meets or exceeds the threshold.
 * When multiple quantiles breach, triggeringValue is the maximum breaching value
 * (worst-case signal for a single tracker "actual" field).
 */
export function compareQuantiles(input: CompareInput): CompareResult {
  const { threshold, quantileValues } = input;
  let triggeringValue = Number.NEGATIVE_INFINITY;

  for (const value of quantileValues) {
    if (value >= threshold && value > triggeringValue) {
      triggeringValue = value;
    }
  }

  if (triggeringValue === Number.NEGATIVE_INFINITY) {
    return { alert: false };
  }

  return { alert: true, triggeringValue };
}
