import { describe, expect, it } from "vitest";
import { parseScheduleEvent } from "@/services/scheduler/schedule-events.ts";

const scheduleId = "11111111-1111-4111-8111-111111111111";

describe("parseScheduleEvent", () => {
  it("parses a valid notify payload", () => {
    expect(
      parseScheduleEvent(
        JSON.stringify({
          table: "pipeline_schedules",
          op: "UPDATE",
          id: scheduleId,
        })
      )
    ).toEqual({
      table: "pipeline_schedules",
      op: "UPDATE",
      id: scheduleId,
    });
  });

  it("returns null for invalid JSON or shape", () => {
    expect(parseScheduleEvent("not-json")).toBeNull();
    expect(
      parseScheduleEvent(JSON.stringify({ table: "other", op: "UPDATE", id: scheduleId }))
    ).toBeNull();
    expect(
      parseScheduleEvent(JSON.stringify({ table: "pipelines", op: "INSERT", id: "not-a-uuid" }))
    ).toBeNull();
  });
});
