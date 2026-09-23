export const QUANTILE_KEY_VALUES: Record<string, string> = {
  quantile_low: "0.1",
  quantile_mid_low: "0.25",
  median: "0.5",
  quantile_mid_high: "0.75",
  quantile_high: "0.9",
};

export function toQuantileValue(key: string): string | null {
  const named = QUANTILE_KEY_VALUES[key];
  if (named) {
    return named;
  }
  const numeric = Number(key);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
    return String(numeric);
  }
  return null;
}
