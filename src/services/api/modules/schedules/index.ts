import { Elysia } from "elysia";
import { ScheduleService } from "@/services/api/modules/schedules/service.ts";
import { idParams, updateScheduleBody } from "@/services/api/modules/schedules/model.ts";

const scheduleService = new ScheduleService();

export const schedulesModule = new Elysia({ prefix: "/schedules", tags: ["Schedules"] })
  .get("/:id", ({ params }) => scheduleService.getSchedule(params.id), {
    params: idParams,
    detail: {
      summary: "Get schedule",
      description: "Get a schedule with its pipeline reference",
      operationId: "getSchedule",
      responses: {
        "200": { description: "Schedule detail" },
        "404": { description: "Schedule not found" },
      },
    },
  })
  .put("/:id", ({ params, body }) => scheduleService.updateSchedule(params.id, body), {
    params: idParams,
    body: updateScheduleBody,
    detail: {
      summary: "Update schedule",
      description: "Partially update a schedule",
      operationId: "updateSchedule",
      responses: {
        "200": { description: "Updated schedule" },
        "400": { description: "Invalid cron expression or input context" },
        "404": { description: "Schedule not found" },
      },
    },
  })
  .delete("/:id", ({ params }) => scheduleService.deleteSchedule(params.id), {
    params: idParams,
    detail: {
      summary: "Delete schedule",
      description: "Delete a schedule",
      operationId: "deleteSchedule",
      responses: {
        "200": { description: "Deleted schedule" },
        "404": { description: "Schedule not found" },
      },
    },
  })
  .post("/:id/pause", ({ params }) => scheduleService.pauseSchedule(params.id), {
    params: idParams,
    detail: {
      summary: "Pause schedule",
      description: "Set a schedule's status to PAUSED",
      operationId: "pauseSchedule",
      responses: {
        "200": { description: "Updated schedule" },
        "404": { description: "Schedule not found" },
      },
    },
  })
  .post("/:id/resume", ({ params }) => scheduleService.resumeSchedule(params.id), {
    params: idParams,
    detail: {
      summary: "Resume schedule",
      description: "Set a schedule's status back to ACTIVE",
      operationId: "resumeSchedule",
      responses: {
        "200": { description: "Updated schedule" },
        "404": { description: "Schedule not found" },
      },
    },
  });
