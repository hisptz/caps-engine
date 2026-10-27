import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn(), post: vi.fn() },
}));

import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import {
  dhis2Notify,
  renderTemplate,
} from "@/services/worker/services/handlers/dhis2Notify/index.ts";
import { dhis2NotifyConfigSchema } from "@/services/worker/services/handlers/dhis2Notify/schemas/config.ts";

const mockPost = vi.mocked(dhis2RestClient.post);

const GROUP = "Kk12LkEWtXp";
const USER = "xE7jOejl9FI";

describe("dhis2-notify handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ status: 201, data: {} });
  });

  it("sends a message conversation with rendered placeholders and passes input through", async () => {
    const input = { jobId: "job-1", status: "SUCCESS" };
    const ctx = buildMockContext({
      pipelineName: "Malaria weekly",
      input,
      handlerConfig: {
        recipients: { userGroups: [GROUP], users: [USER] },
        subject: "{{pipelineName}}: prediction {{input.status}}",
        message: "Job {{input.jobId}} finished at step {{stepName}}. {{runUrl}}",
      },
    });

    const output = await dhis2Notify.execute(ctx);

    expect(output).toBe(input);
    expect(mockPost).toHaveBeenCalledWith("/messageConversations", {
      subject: "Malaria weekly: prediction SUCCESS",
      text: expect.stringMatching(
        new RegExp(`^Job job-1 finished at step ${ctx.step.name}\\. https?://.+#/executions/.+$`)
      ),
      users: [{ id: USER }],
      userGroups: [{ id: GROUP }],
    });
  });

  it("links the run on DHIS2's public URL from system/info", async () => {
    vi.mocked(dhis2RestClient.get).mockResolvedValue({
      data: { contextPath: "https://dhis2.example.org/caps" },
    });
    const ctx = buildMockContext({
      handlerConfig: {
        recipients: { userGroups: [GROUP] },
        subject: "s",
        message: "{{runUrl}}",
      },
    });

    await dhis2Notify.execute(ctx);

    expect(mockPost).toHaveBeenCalledWith(
      "/messageConversations",
      expect.objectContaining({
        text: `https://dhis2.example.org/caps/api/apps/caps-app/index.html#/executions/${ctx.stepExecution.executionId}`,
      })
    );
  });

  it("does not fail the step when sending fails and failOnError is false", async () => {
    mockPost.mockRejectedValue(new Error("SMTP down"));
    const ctx = buildMockContext({
      input: { imported: 3 },
      handlerConfig: { recipients: { userGroups: [GROUP] } },
    });

    await expect(dhis2Notify.execute(ctx)).resolves.toEqual({ imported: 3 });
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("notification failed"),
      expect.objectContaining({ error: "SMTP down" })
    );
  });

  it("fails the step when sending fails and failOnError is true", async () => {
    mockPost.mockRejectedValue(new Error("forbidden"));
    const ctx = buildMockContext({
      handlerConfig: { recipients: { userGroups: [GROUP] }, failOnError: true },
    });

    await expect(dhis2Notify.execute(ctx)).rejects.toThrow("forbidden");
  });

  it("rejects config without recipients", () => {
    expect(dhis2NotifyConfigSchema.safeParse({}).success).toBe(false);
    expect(
      dhis2NotifyConfigSchema.safeParse({ recipients: { userGroups: ["not-a-uid"] } }).success
    ).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("leaves unknown and non-scalar placeholders empty and reports them", () => {
    const missing = new Set<string>();
    const out = renderTemplate(
      "a={{ input.a }} b={{input.b}} obj={{input}}",
      { input: { a: 1 } },
      missing
    );
    expect(out).toBe("a=1 b= obj=");
    expect([...missing].sort()).toEqual(["input", "input.b"]);
  });
});
