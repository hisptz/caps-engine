export type AnalyticsSystemInfo = {
  lastAnalyticsTableSuccess?: string;
  lastAnalyticsTablePartitionSuccess?: string;
  lastAnalyticsTableGeneration?: string;
};

export function analyticsUpTo(info: AnalyticsSystemInfo): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const value of [
    info.lastAnalyticsTableSuccess,
    info.lastAnalyticsTablePartitionSuccess,
    info.lastAnalyticsTableGeneration,
  ]) {
    const time = value ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time > 0 && (!latest || time > latest.time)) {
      latest = { value: value!, time };
    }
  }
  return latest?.value ?? null;
}
