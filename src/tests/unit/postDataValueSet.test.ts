import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { buildMockContext } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { post: vi.fn() },
}));

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { postDataValueSet, unwrapImportSummary } from "@/services/worker/utils/dhis2.ts";

const mockPost = vi.mocked(dhis2RestClient.post);

const importSummary = {
  responseType: "ImportSummary",
  status: "SUCCESS",
  importCount: { imported: 12, updated: 3, ignored: 0, deleted: 0 },
  conflicts: [],
};

const webMessage = (response: unknown, status = "OK") => ({
  httpStatus: status === "OK" ? "OK" : "Conflict",
  httpStatusCode: status === "OK" ? 200 : 409,
  status,
  message: "Import finished",
  response,
});

function conflictError(data: unknown): AxiosError {
  return new AxiosError(
    "Request failed with status code 409",
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    {
      status: 409,
      statusText: "Conflict",
      headers: {},
      config: { headers: new AxiosHeaders() },
      data,
    }
  );
}

const payload = {
  dataValues: [{ dataElement: "de", period: "202501", orgUnit: "ou", value: "1" }],
};

describe("unwrapImportSummary", () => {
  it("unwraps the DHIS2 2.38+ WebMessage envelope", () => {
    expect(unwrapImportSummary(webMessage(importSummary))).toEqual(importSummary);
  });

  it("returns a legacy bare ImportSummary unchanged", () => {
    expect(unwrapImportSummary(importSummary)).toEqual(importSummary);
  });
});

describe("postDataValueSet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the inner import summary with real counts", async () => {
    mockPost.mockResolvedValue({ data: webMessage(importSummary) });
    const summary = await postDataValueSet({ payload, ctx: buildMockContext() });
    expect(summary.status).toBe("SUCCESS");
    expect(summary.importCount).toEqual({ imported: 12, updated: 3, ignored: 0, deleted: 0 });
  });

  it("returns the summary from a 409 instead of throwing", async () => {
    const errorSummary = {
      responseType: "ImportSummary",
      status: "ERROR",
      importCount: { imported: 0, updated: 0, ignored: 1, deleted: 0 },
      conflicts: [{ object: "de", value: "Data element not found" }],
    };
    mockPost.mockRejectedValue(conflictError(webMessage(errorSummary, "ERROR")));
    const summary = await postDataValueSet({ payload, ctx: buildMockContext() });
    expect(summary.status).toBe("ERROR");
    expect(summary.conflicts).toEqual(errorSummary.conflicts);
  });

  it("rethrows non-409 errors", async () => {
    mockPost.mockRejectedValue(new Error("network down"));
    await expect(postDataValueSet({ payload, ctx: buildMockContext() })).rejects.toThrow(
      "network down"
    );
  });
});
