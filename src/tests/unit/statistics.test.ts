import { describe, it, expect } from "vitest";
import {
  mean,
  standardDeviation,
  median,
  quantile,
  cSumMean,
  cSumStandardDeviation,
  cSumPlus196Sd,
  calculateThreshold,
  CSUM_CALCULATION_METHODS,
} from "@/services/worker/utils/statistics.ts";

describe("mean", () => {
  it("returns NaN for empty array", () => {
    expect(mean([])).toBeNaN();
  });

  it("returns the value itself for a single element", () => {
    expect(mean([5])).toBe(5);
  });

  it("returns the arithmetic mean of multiple values", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("returns 0 for all-zero values", () => {
    expect(mean([0, 0, 0])).toBe(0);
  });

  it("handles negative values", () => {
    expect(mean([-2, -4])).toBe(-3);
  });

  it("handles floating point values", () => {
    expect(mean([1.5, 2.5])).toBe(2.0);
  });
});

describe("standardDeviation", () => {
  it("returns NaN for empty array", () => {
    expect(standardDeviation([])).toBeNaN();
  });

  it("returns 0 for a single element", () => {
    expect(standardDeviation([7])).toBe(0);
  });

  it("returns known population SD for [2,4,4,4,5,5,7,9]", () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it("returns 0 when all values are the same", () => {
    expect(standardDeviation([3, 3, 3])).toBe(0);
  });

  it("returns 0 for all-zero values", () => {
    expect(standardDeviation([0, 0, 0])).toBe(0);
  });
});

describe("median", () => {
  it("returns NaN for empty array", () => {
    expect(median([])).toBeNaN();
  });

  it("returns the value itself for a single element", () => {
    expect(median([3])).toBe(3);
  });

  it("returns middle element for odd-length array", () => {
    expect(median([1, 3, 5])).toBe(3);
  });

  it("returns average of two middle elements for even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("sorts the input before computing (does not assume sorted order)", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("does not mutate the original array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("quantile", () => {
  it("returns NaN for empty array", () => {
    expect(quantile([], 0.75)).toBeNaN();
  });

  it("returns the sole value for a single element", () => {
    expect(quantile([42], 0.75)).toBe(42);
  });

  it("returns 75th percentile with linear interpolation (type 7)", () => {
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25);
  });

  it("for five values, 75th percentile equals the second-highest (WHO convention)", () => {
    expect(quantile([10, 20, 30, 40, 50], 0.75)).toBe(40);
  });

  it("does not mutate the original array", () => {
    const input = [5, 1, 3];
    quantile(input, 0.5);
    expect(input).toEqual([5, 1, 3]);
  });
});

describe("C-SUM helpers", () => {
  const window = [10, 20, 30, 40, 50, 60];

  it("cSumMean returns arithmetic mean of window values", () => {
    expect(cSumMean(window)).toBe(35);
  });

  it("cSumStandardDeviation returns population SD of window values", () => {
    expect(cSumStandardDeviation(window)).toBeCloseTo(standardDeviation(window));
  });

  it("cSumPlus196Sd returns mean + 1.96 * SD", () => {
    const m = cSumMean(window);
    const sd = cSumStandardDeviation(window);
    expect(cSumPlus196Sd(window)).toBeCloseTo(m + 1.96 * sd);
  });

  it("returns NaN for empty window", () => {
    expect(cSumMean([])).toBeNaN();
    expect(cSumStandardDeviation([])).toBeNaN();
    expect(cSumPlus196Sd([])).toBeNaN();
  });
});

describe("calculateThreshold", () => {
  const values = [10, 20, 30];
  const m = 20;
  const sd = standardDeviation(values);

  it("method 'mean' returns the arithmetic mean", () => {
    expect(calculateThreshold("mean", values)).toBe(m);
  });

  it("method 'SD' returns the standard deviation", () => {
    expect(calculateThreshold("SD", values)).toBeCloseTo(sd);
  });

  it("method 'median' returns the median", () => {
    expect(calculateThreshold("median", values)).toBe(20);
  });

  it("method 'mean + SD' returns mean plus SD", () => {
    expect(calculateThreshold("mean + SD", values)).toBeCloseTo(m + sd);
  });

  it("method 'mean + 2SD' returns mean plus two standard deviations", () => {
    expect(calculateThreshold("mean + 2SD", values)).toBeCloseTo(m + 2 * sd);
  });

  it("method '75th percentile' returns the 75th percentile of same-period values", () => {
    expect(calculateThreshold("75th percentile", [10, 20, 30, 40, 50])).toBe(40);
  });

  it("method '25th percentile' returns the 25th percentile of same-period values", () => {
    expect(calculateThreshold("25th percentile", [10, 20, 30, 40, 50])).toBe(20);
  });

  it("method 'C-SUM' uses windowValues when provided", () => {
    expect(calculateThreshold("C-SUM", [10, 20], { windowValues: [1, 2, 3, 4, 5, 6] })).toBe(3.5);
  });

  it("method 'C-SUM SD' uses windowValues when provided", () => {
    const window = [1, 2, 3, 4, 5, 6];
    expect(calculateThreshold("C-SUM SD", [], { windowValues: window })).toBeCloseTo(
      standardDeviation(window)
    );
  });

  it("method 'C-SUM + 1.96SD' uses windowValues when provided", () => {
    const window = [1, 2, 3, 4, 5, 6];
    expect(calculateThreshold("C-SUM + 1.96SD", [], { windowValues: window })).toBeCloseTo(
      cSumPlus196Sd(window)
    );
  });

  it("C-SUM methods return NaN when windowValues is missing", () => {
    expect(calculateThreshold("C-SUM", [1, 2, 3])).toBeNaN();
    expect(calculateThreshold("C-SUM SD", [1, 2, 3])).toBeNaN();
    expect(calculateThreshold("C-SUM + 1.96SD", [1, 2, 3])).toBeNaN();
  });

  it("returns NaN for empty input regardless of method", () => {
    expect(calculateThreshold("mean", [])).toBeNaN();
    expect(calculateThreshold("SD", [])).toBeNaN();
    expect(calculateThreshold("median", [])).toBeNaN();
    expect(calculateThreshold("mean + SD", [])).toBeNaN();
    expect(calculateThreshold("mean + 2SD", [])).toBeNaN();
    expect(calculateThreshold("75th percentile", [])).toBeNaN();
    expect(calculateThreshold("25th percentile", [])).toBeNaN();
    expect(calculateThreshold("C-SUM", [], { windowValues: [] })).toBeNaN();
  });
});

describe("CSUM_CALCULATION_METHODS", () => {
  it("lists all C-SUM family methods", () => {
    expect(CSUM_CALCULATION_METHODS).toEqual(["C-SUM", "C-SUM SD", "C-SUM + 1.96SD"]);
  });
});
