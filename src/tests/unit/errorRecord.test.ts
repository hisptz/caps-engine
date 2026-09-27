import { describe, it, expect } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import {
  groupConflicts,
  MAX_ERROR_MESSAGE_LENGTH,
  StepError,
  toErrorRecord,
} from "@/shared/utils/error.ts";

describe("groupConflicts", () => {
  it("collapses repeated values, counts them and samples objects", () => {
    const conflicts = [
      ...Array.from({ length: 8 }, (_, i) => ({ object: `ou${i}`, value: "Org unit not found" })),
      { object: "de1", value: "Data element not found" },
    ];

    expect(groupConflicts(conflicts)).toEqual([
      { value: "Org unit not found", count: 8, objects: ["ou0", "ou1", "ou2", "ou3", "ou4"] },
      { value: "Data element not found", count: 1, objects: ["de1"] },
    ]);
  });
});

describe("toErrorRecord", () => {
  it("keeps short plain errors as-is with no details", () => {
    const record = toErrorRecord(new Error("boom"));
    expect(record.errorMessage).toBe("boom");
    expect(record.errorDetails).toBeUndefined();
  });

  it("truncates long messages and keeps the original in details", () => {
    const long = "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 50);
    const record = toErrorRecord(new Error(long));
    expect(record.errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(record.errorMessage.endsWith("…")).toBe(true);
    expect(record.errorDetails?.fullMessage).toBe(long);
  });

  it("carries StepError details through", () => {
    const record = toErrorRecord(
      new StepError("Upstream failed", { source: "dhis2", totalConflicts: 3 })
    );
    expect(record.errorMessage).toBe("Upstream failed");
    expect(record.errorDetails).toEqual({ source: "dhis2", totalConflicts: 3 });
  });

  it("extracts status, request and upstream message from axios errors", () => {
    const err = new AxiosError(
      "Request failed with status code 500",
      "ERR_BAD_RESPONSE",
      { method: "post", url: "/predictions", headers: new AxiosHeaders() },
      undefined,
      {
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { detail: "Model crashed" },
      }
    );

    expect(toErrorRecord(err).errorDetails).toEqual({
      httpStatus: 500,
      request: "POST /predictions",
      description: "Model crashed",
    });
  });
});
