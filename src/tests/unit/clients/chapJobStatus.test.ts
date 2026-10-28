import { describe, it, expect } from "vitest";
import { jobStatusFromResponse } from "@/services/worker/utils/chap.ts";

describe("jobStatusFromResponse", () => {
  it("reads the bare status string CHAP up to 2.5 answers", () => {
    expect(jobStatusFromResponse("SUCCESS")).toBe("SUCCESS");
  });

  it("reads the status from the whole job later CHAP versions answer", () => {
    expect(
      jobStatusFromResponse({
        id: "job-1",
        type: "create_prediction",
        name: "forecast",
        status: "STARTED",
        start_time: "2026-10-28T15:58:47.329978+00:00",
        end_time: null,
        result: null,
      })
    ).toBe("STARTED");
  });
});
