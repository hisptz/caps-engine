import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";
import { AxiosError } from "axios";

vi.mock("@/services/worker/utils/dhis2.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/worker/utils/dhis2.ts")>();
  return {
    ...actual,
    postTrackerEvents: vi.fn(),
  };
});

const mockFileJson = vi.fn();
const mockBunFile = vi.fn(() => ({ json: mockFileJson }));

import { postTrackerEvents } from "@/services/worker/utils/dhis2.ts";
import { eventDataUpload } from "@/services/worker/services/handlers/eventDataUpload/index.ts";
import { StepSkippedError } from "@/services/worker/types/service.ts";

const mockPostTrackerEvents = vi.mocked(postTrackerEvents);

const samplePayload = {
  events: [
    {
      program: "ALERT_PROG",
      programStage: "ALERT_STAGE",
      orgUnit: "OU1",
      occurredAt: "2023-01-01T00:00:00.000",
      status: "COMPLETED",
      dataValues: [{ dataElement: "DE1", value: "1" }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  stubBun({ file: mockBunFile });
  mockFileJson.mockResolvedValue(samplePayload);
  mockPostTrackerEvents.mockResolvedValue({
    status: "OK",
    stats: { created: 1, updated: 0, ignored: 0, deleted: 0, total: 1 },
  });
});

describe("event-data-upload", () => {
  it("skips when prior step count is 0", async () => {
    const ctx = buildMockContext({ input: { count: 0 } });
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(StepSkippedError);
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(/No tracker events to upload/);
    expect(mockPostTrackerEvents).not.toHaveBeenCalled();
  });

  it("requires ctx.input.filename when count is greater than 0", async () => {
    const ctx = buildMockContext({ input: { count: 2 } });
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(/requires \{ filename \}/);
  });

  it("rejects empty events array", async () => {
    mockFileJson.mockResolvedValue({ events: [] });
    const ctx = buildMockContext({ input: { filename: "alert-test.json", count: 1 } });
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(/contains no events/);
  });

  it("uploads tracker events and returns import summary", async () => {
    const ctx = buildMockContext({ input: { filename: "alert-test.json", count: 1 } });
    const result = await eventDataUpload.execute(ctx);

    expect(mockPostTrackerEvents).toHaveBeenCalledWith({
      payload: samplePayload,
      ctx,
      importStrategy: "CREATE",
    });
    expect(result).toEqual({
      status: "OK",
      created: 1,
      updated: 0,
      ignored: 0,
      deleted: 0,
    });
  });

  it("fails on ERROR import status", async () => {
    mockPostTrackerEvents.mockResolvedValue({
      status: "ERROR",
      stats: { created: 0, updated: 0, ignored: 0, deleted: 0, total: 0 },
    });

    const ctx = buildMockContext({ input: { filename: "alert-test.json", count: 1 } });
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(/tracker import failed/);
  });

  it("handles 409 conflict response from DHIS2", async () => {
    const axiosError = new AxiosError("Conflict");
    axiosError.response = {
      status: 409,
      data: { status: "ERROR" },
      statusText: "Conflict",
      headers: {},
      config: {} as never,
    };
    mockPostTrackerEvents.mockRejectedValue(axiosError);

    const ctx = buildMockContext({ input: { filename: "alert-test.json", count: 1 } });
    await expect(eventDataUpload.execute(ctx)).rejects.toThrow(/tracker import failed/);
  });
});
