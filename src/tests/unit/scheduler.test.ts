import { ScheduleStatus } from "@db/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "@/services/scheduler/scheduler.ts";
import type { ScheduleEventListen } from "@/services/scheduler/schedule-events.ts";
import type { TriggerService } from "@/services/scheduler/trigger-service.ts";
import { WorkflowStartError } from "@/shared/pipeline/workflows.ts";

const SCHEDULE_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE_ID = "22222222-2222-4111-8111-222222222222";
const WORKFLOW_ID = "33333333-3333-4111-8111-333333333333";

const scheduledWorkflow = {
  id: WORKFLOW_ID,
  name: "Malawi monthly",
  description: null,
  isActive: true,
  cronExpr: "0 6 1 * *",
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const activeSchedule = {
  id: SCHEDULE_ID,
  pipelineId: PIPELINE_ID,
  name: "Daily 06:00",
  description: null,
  status: ScheduleStatus.ACTIVE,
  cronExpr: "0 6 * * *",
  inputContext: { steps: { "step-a": { orgUnit: "abc" } } },
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  pipeline: { isActive: true },
};

function createPrisma(schedule = activeSchedule) {
  return {
    pipelineSchedule: {
      findMany: vi.fn().mockResolvedValue([schedule]),
      findUnique: vi.fn().mockResolvedValue(schedule),
      update: vi.fn().mockResolvedValue(schedule),
    },
    pipeline: {
      findUnique: vi.fn().mockResolvedValue({
        id: PIPELINE_ID,
        isActive: true,
        schedules: [schedule],
      }),
    },
    workflow: {
      findMany: vi.fn().mockResolvedValue([scheduledWorkflow]),
      findUnique: vi.fn().mockResolvedValue(scheduledWorkflow),
      update: vi.fn().mockResolvedValue(scheduledWorkflow),
    },
  };
}

describe("Scheduler", () => {
  let listenCalls = 0;
  let prisma: ReturnType<typeof createPrisma>;
  let triggerPipeline: ReturnType<typeof vi.fn>;
  let triggerWorkflow: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  const listen: ScheduleEventListen = async (_channel, _notify, onConnect) => {
    listenCalls += 1;
    await onConnect?.();
    return { unlisten: vi.fn().mockResolvedValue(undefined) };
  };

  beforeEach(async () => {
    listenCalls = 0;
    prisma = createPrisma();
    triggerPipeline = vi.fn().mockResolvedValue({ executionId: "exec-1", skipped: false });
    triggerWorkflow = vi
      .fn()
      .mockResolvedValue({ workflowRunId: "run-1", started: [], skipped: [] });
    scheduler = new Scheduler(
      prisma as never,
      { triggerPipeline, triggerWorkflow } as unknown as TriggerService,
      listen
    );
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  it("loads active schedules into memory on connect", () => {
    expect(listenCalls).toBe(1);
    expect(scheduler.has(SCHEDULE_ID)).toBe(true);
  });

  it("passes Croner context into TriggerService on tick", async () => {
    await scheduler.getJob(SCHEDULE_ID)?.trigger();

    expect(triggerPipeline).toHaveBeenCalledWith(
      PIPELINE_ID,
      expect.objectContaining({
        triggeredBy: "scheduler",
        scheduleId: SCHEDULE_ID,
        scheduleInputContext: { steps: { "step-a": { orgUnit: "abc" } } },
        context: { scheduleId: SCHEDULE_ID, scheduleName: "Daily 06:00" },
      })
    );
    expect(prisma.pipelineSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SCHEDULE_ID },
        data: expect.objectContaining({ lastRunAt: expect.any(Date) }),
      })
    );
  });

  it("does not advance lastRunAt when the trigger is skipped", async () => {
    triggerPipeline.mockResolvedValueOnce({
      executionId: "",
      skipped: true,
      skipReason: "Active execution is already running (SKIP policy)",
    });

    await scheduler.getJob(SCHEDULE_ID)?.trigger();

    expect(prisma.pipelineSchedule.update).not.toHaveBeenCalled();
  });

  it("removes a job when the schedule is paused", async () => {
    prisma.pipelineSchedule.findUnique.mockResolvedValue({
      ...activeSchedule,
      status: ScheduleStatus.PAUSED,
    });

    await scheduler.handleNotify(
      JSON.stringify({ table: "pipeline_schedules", op: "UPDATE", id: SCHEDULE_ID })
    );

    expect(scheduler.has(SCHEDULE_ID)).toBe(false);
  });

  it("removes a job when the schedule is deleted", async () => {
    await scheduler.handleNotify(
      JSON.stringify({ table: "pipeline_schedules", op: "DELETE", id: SCHEDULE_ID })
    );

    expect(scheduler.has(SCHEDULE_ID)).toBe(false);
  });

  it("removes jobs when the pipeline is deactivated", async () => {
    prisma.pipeline.findUnique.mockResolvedValue({
      id: PIPELINE_ID,
      isActive: false,
      schedules: [activeSchedule],
    });

    await scheduler.handleNotify(
      JSON.stringify({ table: "pipelines", op: "UPDATE", id: PIPELINE_ID })
    );

    expect(scheduler.has(SCHEDULE_ID)).toBe(false);
  });

  it("recreates the job when cronExpr or context changes", async () => {
    const previous = scheduler.getJob(SCHEDULE_ID);
    prisma.pipelineSchedule.findUnique.mockResolvedValue({
      ...activeSchedule,
      cronExpr: "0 7 * * *",
      inputContext: { steps: { "step-a": { orgUnit: "xyz" } } },
    });

    await scheduler.handleNotify(
      JSON.stringify({ table: "pipeline_schedules", op: "UPDATE", id: SCHEDULE_ID })
    );

    const next = scheduler.getJob(SCHEDULE_ID);
    expect(next).toBeDefined();
    expect(next).not.toBe(previous);
    expect(previous?.isStopped()).toBe(true);

    await next?.trigger();
    expect(triggerPipeline).toHaveBeenCalledWith(
      PIPELINE_ID,
      expect.objectContaining({
        scheduleInputContext: { steps: { "step-a": { orgUnit: "xyz" } } },
      })
    );
  });

  describe("workflow schedules", () => {
    it("loads scheduled, active workflows on connect", () => {
      expect(prisma.workflow.findMany).toHaveBeenCalledWith({
        where: { isActive: true, cronExpr: { not: null } },
      });
      expect(scheduler.hasWorkflow(WORKFLOW_ID)).toBe(true);
    });

    it("starts the workflow and records the run time on tick", async () => {
      await scheduler.getWorkflowJob(WORKFLOW_ID)?.trigger();

      expect(triggerWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
      expect(prisma.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WORKFLOW_ID },
          data: expect.objectContaining({ lastRunAt: expect.any(Date) }),
        })
      );
    });

    it("does not record a run when the workflow could not start", async () => {
      triggerWorkflow.mockRejectedValueOnce(
        new WorkflowStartError("Workflow has no pipelines to start", "empty")
      );

      await scheduler.getWorkflowJob(WORKFLOW_ID)?.trigger();

      expect(prisma.workflow.update).not.toHaveBeenCalled();
    });

    it("removes the job when the schedule is cleared", async () => {
      prisma.workflow.findUnique.mockResolvedValue({ ...scheduledWorkflow, cronExpr: null });

      await scheduler.handleNotify(
        JSON.stringify({ table: "workflows", op: "UPDATE", id: WORKFLOW_ID })
      );

      expect(scheduler.hasWorkflow(WORKFLOW_ID)).toBe(false);
    });

    it("removes the job when the workflow is deactivated or deleted", async () => {
      prisma.workflow.findUnique.mockResolvedValue({ ...scheduledWorkflow, isActive: false });
      await scheduler.handleNotify(
        JSON.stringify({ table: "workflows", op: "UPDATE", id: WORKFLOW_ID })
      );
      expect(scheduler.hasWorkflow(WORKFLOW_ID)).toBe(false);

      prisma.workflow.findUnique.mockResolvedValue(scheduledWorkflow);
      await scheduler.handleNotify(
        JSON.stringify({ table: "workflows", op: "UPDATE", id: WORKFLOW_ID })
      );
      expect(scheduler.hasWorkflow(WORKFLOW_ID)).toBe(true);

      await scheduler.handleNotify(
        JSON.stringify({ table: "workflows", op: "DELETE", id: WORKFLOW_ID })
      );
      expect(scheduler.hasWorkflow(WORKFLOW_ID)).toBe(false);
    });
  });
});
