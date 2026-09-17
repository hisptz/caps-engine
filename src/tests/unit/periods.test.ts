import { describe, it, expect } from "vitest";
import {
  generateSubPeriods,
  getHistoricalSubPeriods,
  getSubPeriodWindow,
  getHistoricalWindowPeriods,
  isoWeeksInYear,
} from "@/services/worker/utils/periods.ts";

describe("isoWeeksInYear", () => {
  it("returns 52 for a typical year (2023)", () => {
    expect(isoWeeksInYear(2023)).toBe(52);
  });

  it("returns 53 for 2020 (Jan 1 is Wednesday in a leap year)", () => {
    expect(isoWeeksInYear(2020)).toBe(53);
  });

  it("returns 53 for 2015 (Jan 1 is Thursday)", () => {
    expect(isoWeeksInYear(2015)).toBe(53);
  });

  it("returns 52 for 2022", () => {
    expect(isoWeeksInYear(2022)).toBe(52);
  });
});

describe("generateSubPeriods", () => {
  describe("Monthly", () => {
    it("generates 12 periods for 2023", () => {
      const result = generateSubPeriods(2023, "Monthly");
      expect(result).toHaveLength(12);
    });

    it("first period is 202301", () => {
      expect(generateSubPeriods(2023, "Monthly")[0]).toBe("202301");
    });

    it("last period is 202312", () => {
      expect(generateSubPeriods(2023, "Monthly")[11]).toBe("202312");
    });

    it("zero-pads single-digit months", () => {
      const result = generateSubPeriods(2023, "Monthly");
      expect(result[8]).toBe("202309"); // September
    });
  });

  describe("Quarterly", () => {
    it("generates exactly 4 periods", () => {
      expect(generateSubPeriods(2023, "Quarterly")).toHaveLength(4);
    });

    it("generates the correct quarter identifiers", () => {
      expect(generateSubPeriods(2023, "Quarterly")).toEqual([
        "2023Q1",
        "2023Q2",
        "2023Q3",
        "2023Q4",
      ]);
    });
  });

  describe("BiMonthly", () => {
    it("generates 6 bi-monthly periods", () => {
      expect(generateSubPeriods(2023, "BiMonthly")).toHaveLength(6);
    });

    it("generates the correct bi-monthly identifiers", () => {
      expect(generateSubPeriods(2023, "BiMonthly")).toEqual([
        "202301B",
        "202302B",
        "202303B",
        "202304B",
        "202305B",
        "202306B",
      ]);
    });
  });

  describe("SixMonthly", () => {
    it("generates exactly 2 periods", () => {
      expect(generateSubPeriods(2023, "SixMonthly")).toHaveLength(2);
    });

    it("generates the correct six-monthly identifiers", () => {
      expect(generateSubPeriods(2023, "SixMonthly")).toEqual(["2023S1", "2023S2"]);
    });
  });

  describe("Weekly", () => {
    it("generates 52 weeks for 2023 (a 52-week year)", () => {
      expect(generateSubPeriods(2023, "Weekly")).toHaveLength(52);
    });

    it("generates 53 weeks for 2020 (a 53-week year)", () => {
      expect(generateSubPeriods(2020, "Weekly")).toHaveLength(53);
    });

    it("first week is zero-padded", () => {
      expect(generateSubPeriods(2023, "Weekly")[0]).toBe("2023W01");
    });

    it("last week of a 52-week year is W52", () => {
      const result = generateSubPeriods(2023, "Weekly");
      expect(result[result.length - 1]).toBe("2023W52");
    });

    it("last week of a 53-week year is W53", () => {
      const result = generateSubPeriods(2020, "Weekly");
      expect(result[result.length - 1]).toBe("2020W53");
    });
  });
});

describe("getHistoricalSubPeriods", () => {
  it("returns empty array when count is 0", () => {
    expect(getHistoricalSubPeriods("202301", 2023, 0)).toEqual([]);
  });

  it("returns exactly one period when count is 1", () => {
    expect(getHistoricalSubPeriods("202301", 2023, 1)).toEqual(["202201"]);
  });

  describe("Monthly periods", () => {
    it("shifts the year prefix for each lookback year", () => {
      expect(getHistoricalSubPeriods("202301", 2023, 3)).toEqual(["202201", "202101", "202001"]);
    });

    it("preserves the zero-padded month suffix", () => {
      expect(getHistoricalSubPeriods("202309", 2023, 2)).toEqual(["202209", "202109"]);
    });
  });

  describe("Quarterly periods", () => {
    it("shifts the year prefix while keeping the quarter suffix", () => {
      expect(getHistoricalSubPeriods("2023Q2", 2023, 2)).toEqual(["2022Q2", "2021Q2"]);
    });
  });

  describe("BiMonthly periods", () => {
    it("shifts the year prefix while keeping the bi-monthly suffix", () => {
      expect(getHistoricalSubPeriods("202304B", 2023, 2)).toEqual(["202204B", "202104B"]);
    });
  });

  describe("SixMonthly periods", () => {
    it("shifts the year prefix while keeping the semester suffix", () => {
      expect(getHistoricalSubPeriods("2023S2", 2023, 4)).toEqual([
        "2022S2",
        "2021S2",
        "2020S2",
        "2019S2",
      ]);
    });
  });

  describe("Weekly periods", () => {
    it("shifts the ISO year prefix while keeping the week suffix", () => {
      expect(getHistoricalSubPeriods("2023W05", 2023, 3)).toEqual([
        "2022W05",
        "2021W05",
        "2020W05",
      ]);
    });
  });

  it("returns periods in descending year order (most recent first)", () => {
    const result = getHistoricalSubPeriods("2023Q1", 2023, 3);
    expect(result[0]).toBe("2022Q1");
    expect(result[1]).toBe("2021Q1");
    expect(result[2]).toBe("2020Q1");
  });
});

describe("getSubPeriodWindow", () => {
  describe("Monthly", () => {
    it("returns prev, current, next for a mid-year month", () => {
      expect(getSubPeriodWindow("202303", "Monthly")).toEqual(["202302", "202303", "202304"]);
    });

    it("crosses year boundary at January (Dec prior year)", () => {
      expect(getSubPeriodWindow("202301", "Monthly")).toEqual(["202212", "202301", "202302"]);
    });

    it("crosses year boundary at December (Jan next year)", () => {
      expect(getSubPeriodWindow("202312", "Monthly")).toEqual(["202311", "202312", "202401"]);
    });
  });

  describe("Weekly", () => {
    it("crosses year boundary at week 1", () => {
      expect(getSubPeriodWindow("2023W01", "Weekly")).toEqual(["2022W52", "2023W01", "2023W02"]);
    });

    it("crosses year boundary at last week of 52-week year", () => {
      expect(getSubPeriodWindow("2023W52", "Weekly")).toEqual(["2023W51", "2023W52", "2024W01"]);
    });

    it("crosses year boundary at last week of 53-week year", () => {
      expect(getSubPeriodWindow("2020W53", "Weekly")).toEqual(["2020W52", "2020W53", "2021W01"]);
    });
  });
});

describe("getHistoricalWindowPeriods", () => {
  it("returns unique periods for 2 years of January windows", () => {
    const result = getHistoricalWindowPeriods("202301", 2023, 2);
    expect(result.sort()).toEqual(
      ["202012", "202101", "202102", "202112", "202201", "202202"].sort()
    );
  });

  it("returns 3 * count periods when windows do not overlap", () => {
    const result = getHistoricalWindowPeriods("202306", 2023, 2);
    expect(result).toHaveLength(6);
    expect(result).toContain("202205");
    expect(result).toContain("202206");
    expect(result).toContain("202207");
  });
});
