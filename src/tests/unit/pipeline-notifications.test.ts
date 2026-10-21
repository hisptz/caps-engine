import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn(), post: vi.fn() },
}));

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import {
  formatNotificationDate,
  formatNotificationDateTime,
  notifyPipelineFailure,
} from "@/services/worker/utils/notifications.ts";
import {
  pipelineConfigSchema,
  readPipelineNotifications,
} from "@/shared/pipeline/notifications.ts";

const mockPost = vi.mocked(dhis2RestClient.post);
const mockGet = vi.mocked(dhis2RestClient.get);

const GROUP = "Kk12LkEWtXp";

describe("notifyPipelineFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ status: 201, data: {} });
  });

  it("sends a DHIS2 message to the on-failure recipients", async () => {
    await notifyPipelineFailure({
      pipeline: {
        name: "Malaria weekly",
        config: { notifications: { onFailure: { userGroups: [GROUP] } } },
      },
      executionId: "exec-1",
      stepName: "Prediction Poll",
      errorMessage: "CHAP job FAILURE",
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0]!;
    expect(url).toBe("/messageConversations");
    expect(body).toMatchObject({
      subject: 'CAPS: pipeline "Malaria weekly" failed',
      users: [],
      userGroups: [{ id: GROUP }],
    });
    const text = (body as { text: string }).text;
    expect(text).toContain('failed at step "Prediction Poll"');
    expect(text).toContain("Run: exec-1");
    expect(text).toContain("Error: CHAP job FAILURE");
  });

  it("does nothing when no failure recipients are configured", async () => {
    await notifyPipelineFailure({
      pipeline: { name: "p", config: {} },
      executionId: "exec-1",
      stepName: "s",
    });
    await notifyPipelineFailure({
      pipeline: { name: "p", config: { notifications: { onFailure: { userGroups: [] } } } },
      executionId: "exec-1",
      stepName: "s",
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("never throws when DHIS2 rejects the message", async () => {
    mockPost.mockRejectedValue(new Error("403"));
    await expect(
      notifyPipelineFailure({
        pipeline: {
          name: "p",
          config: { notifications: { onFailure: { userGroups: [GROUP] } } },
        },
        executionId: "exec-1",
      })
    ).resolves.toBeUndefined();
  });
});

describe("pipeline config notifications", () => {
  it("keeps unrelated config keys and validates recipient UIDs", () => {
    const parsed = pipelineConfigSchema.safeParse({
      other: 1,
      notifications: { onFailure: { userGroups: [GROUP] } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ other: 1 });

    expect(
      pipelineConfigSchema.safeParse({ notifications: { onFailure: { userGroups: ["bad"] } } })
        .success
    ).toBe(false);
  });

  it("reads invalid stored settings as no notifications", () => {
    expect(readPipelineNotifications(null)).toEqual({});
    expect(readPipelineNotifications({ notifications: { onFailure: "x" } })).toEqual({});
  });
});

describe("notification times", () => {
  // 2026-10-19 22:30 UTC is already 20 October in Nairobi (UTC+3).
  const instant = new Date("2026-10-19T22:30:00Z");

  it("formats in the given time zone", () => {
    expect(formatNotificationDateTime(instant, "Africa/Nairobi")).toBe(
      "20 Oct 2026, 01:30 (Africa/Nairobi)"
    );
    expect(formatNotificationDate(instant, "Africa/Nairobi")).toBe("2026-10-20");
    expect(formatNotificationDate(instant, "UTC")).toBe("2026-10-19");
  });

  it("writes the failure time in the DHIS2 server time zone", async () => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ status: 201, data: {} });
    mockGet.mockResolvedValue({ data: { serverTimeZoneId: "Africa/Nairobi" } });

    await notifyPipelineFailure({
      pipeline: { name: "p", config: { notifications: { onFailure: { userGroups: [GROUP] } } } },
      executionId: "exec-1",
    });

    expect(mockGet).toHaveBeenCalledWith("/system/info", expect.anything());
    const text = (mockPost.mock.calls[0]![1] as { text: string }).text;
    expect(text).toMatch(/Time: .+ \(Africa\/Nairobi\)/);
  });
});
