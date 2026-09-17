import { describe, it, expect } from "vitest";
import { compareQuantiles } from "@/services/worker/services/handlers/alertGeneration/utils/compareQuantiles.ts";

describe("compareQuantiles", () => {
  it("returns no alert when all values are below threshold", () => {
    expect(compareQuantiles({ threshold: 10, quantileValues: [1, 5, 9] })).toEqual({
      alert: false,
    });
  });

  it("returns no alert for empty quantile list", () => {
    expect(compareQuantiles({ threshold: 10, quantileValues: [] })).toEqual({ alert: false });
  });

  it("alerts when a single value equals threshold", () => {
    expect(compareQuantiles({ threshold: 10, quantileValues: [10] })).toEqual({
      alert: true,
      triggeringValue: 10,
    });
  });

  it("alerts when any value exceeds threshold and uses max breaching value", () => {
    expect(compareQuantiles({ threshold: 10, quantileValues: [3, 12, 8, 15] })).toEqual({
      alert: true,
      triggeringValue: 15,
    });
  });
});
