import { describe, expect, it } from "vitest";
import { createScheduleBody } from "@/services/api/modules/pipelines/model.ts";
import { updateScheduleBody } from "@/services/api/modules/schedules/model.ts";

describe("POST /pipelines/:id/schedules", () => {
  it("accepts a cron-only body", () => {
    expect(
      createScheduleBody.parse({
        name: "Daily 06:00",
        cronExpr: "0 6 * * *",
      })
    ).toEqual({
      name: "Daily 06:00",
      cronExpr: "0 6 * * *",
    });
  });

  it("requires cronExpr and rejects interval/type fields", () => {
    expect(createScheduleBody.safeParse({ name: "Daily" }).success).toBe(false);
    expect(
      createScheduleBody.safeParse({
        name: "Daily",
        cronExpr: "0 6 * * *",
        type: "INTERVAL",
      }).success
    ).toBe(false);
    expect(
      createScheduleBody.safeParse({
        name: "Daily",
        cronExpr: "0 6 * * *",
        intervalMs: 5000,
      }).success
    ).toBe(false);
  });
});

describe("PUT /schedules/:id", () => {
  it("accepts a cronExpr update", () => {
    expect(updateScheduleBody.parse({ cronExpr: "0 4 * * *" })).toEqual({
      cronExpr: "0 4 * * *",
    });
  });

  it("rejects intervalMs", () => {
    expect(updateScheduleBody.safeParse({ intervalMs: 1000 }).success).toBe(false);
  });
});
