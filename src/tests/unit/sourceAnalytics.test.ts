import { describe, it, expect } from "vitest";
import { analyticsUpTo } from "@/shared/utils/sourceAnalytics.ts";

describe("analyticsUpTo", () => {
  it("uses the last full analytics run, ignoring unset (1970) partition runs", () => {
    expect(
      analyticsUpTo({
        lastAnalyticsTableSuccess: "2026-09-28T02:09:20.026",
        lastAnalyticsTablePartitionSuccess: "1970-01-01T00:00:00.000",
      })
    ).toBe("2026-09-28T02:09:20.026");
  });

  it("prefers a later partition (continuous analytics) run", () => {
    expect(
      analyticsUpTo({
        lastAnalyticsTableSuccess: "2026-09-28T02:00:00.000",
        lastAnalyticsTablePartitionSuccess: "2026-09-28T11:30:00.000",
      })
    ).toBe("2026-09-28T11:30:00.000");
  });

  it("falls back to the older field name, and to null when nothing is reported", () => {
    expect(analyticsUpTo({ lastAnalyticsTableGeneration: "2024-01-02T00:00:00.000" })).toBe(
      "2024-01-02T00:00:00.000"
    );
    expect(analyticsUpTo({})).toBeNull();
  });
});
