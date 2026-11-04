import { Cron } from "croner";
import {
  ScheduleStatus,
  type PipelineSchedule,
  type PrismaClient,
  type Workflow,
} from "@db/client";
import type { TriggerService } from "@/services/scheduler/trigger-service.ts";
import {
  parseScheduleEvent,
  SCHEDULE_EVENTS_CHANNEL,
  type ScheduleEventListen,
  type ScheduleEventSubscription,
} from "@/services/scheduler/schedule-events.ts";
import { CRON_PATTERN_MODE } from "@/shared/utils/cron.ts";
import { ServiceType } from "@/shared/constants/service.ts";
import { serviceLogger } from "@/shared/utils/logger.ts";
import { getServerTimezone } from "@/shared/utils/timezone.ts";
import { WorkflowStartError } from "@/shared/pipeline/workflows.ts";

export type ScheduleJobContext = {
  scheduleId: string;
  pipelineId: string;
  name: string;
  inputContext: Record<string, unknown>;
};

export type WorkflowJobContext = {
  workflowId: string;
  name: string;
};

type LoadedSchedule = PipelineSchedule & {
  pipeline: { isActive: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotInputContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function isEligible(schedule: LoadedSchedule): boolean {
  return schedule.status === ScheduleStatus.ACTIVE && schedule.pipeline.isActive;
}

function isWorkflowEligible(
  workflow: Pick<Workflow, "isActive" | "cronExpr">
): workflow is Pick<Workflow, "isActive"> & { cronExpr: string } {
  return workflow.isActive && Boolean(workflow.cronExpr);
}

export class Scheduler {
  private readonly jobs = new Map<string, Cron<ScheduleJobContext>>();
  private readonly workflowJobs = new Map<string, Cron<WorkflowJobContext>>();
  private subscription: ScheduleEventSubscription | null = null;

  constructor(
    private prisma: PrismaClient,
    private triggerService: TriggerService,
    private listen: ScheduleEventListen
  ) {}

  async start(): Promise<void> {
    serviceLogger.info(ServiceType.SCHEDULER, "Starting in-memory Croner registry");
    this.subscription = await this.listen(
      SCHEDULE_EVENTS_CHANNEL,
      (payload) => {
        void this.handleNotify(payload);
      },
      () => this.reloadAll()
    );
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unlisten();
      this.subscription = null;
    }
    for (const scheduleId of [...this.jobs.keys()]) {
      this.removeJob(scheduleId);
    }
    for (const workflowId of [...this.workflowJobs.keys()]) {
      this.removeWorkflowJob(workflowId);
    }
    serviceLogger.info(ServiceType.SCHEDULER, "Stopped");
  }

  has(scheduleId: string): boolean {
    return this.jobs.has(scheduleId);
  }

  getJob(scheduleId: string): Cron<ScheduleJobContext> | undefined {
    return this.jobs.get(scheduleId);
  }

  hasWorkflow(workflowId: string): boolean {
    return this.workflowJobs.has(workflowId);
  }

  getWorkflowJob(workflowId: string): Cron<WorkflowJobContext> | undefined {
    return this.workflowJobs.get(workflowId);
  }

  async handleNotify(payload: string): Promise<void> {
    const event = parseScheduleEvent(payload);
    if (!event) {
      serviceLogger.warn(ServiceType.SCHEDULER, `Ignored malformed schedule event: ${payload}`);
      return;
    }

    try {
      if (event.table === "workflows") {
        await this.syncWorkflow(event.id, event.op === "DELETE");
        return;
      }

      if (event.table === "pipelines") {
        await this.syncPipeline(event.id, event.op === "DELETE");
        return;
      }

      if (event.op === "DELETE") {
        this.removeJob(event.id);
        return;
      }

      await this.syncSchedule(event.id);
    } catch (err) {
      serviceLogger.error(
        ServiceType.SCHEDULER,
        `Failed handling schedule event ${event.table} ${event.op} ${event.id}: ${String(err)}`
      );
    }
  }

  private async reloadAll(): Promise<void> {
    const schedules = await this.prisma.pipelineSchedule.findMany({
      where: {
        status: ScheduleStatus.ACTIVE,
        pipeline: { isActive: true },
      },
      include: { pipeline: { select: { isActive: true } } },
    });

    const keep = new Set(schedules.map((schedule) => schedule.id));
    for (const scheduleId of [...this.jobs.keys()]) {
      if (!keep.has(scheduleId)) {
        this.removeJob(scheduleId);
      }
    }

    for (const schedule of schedules) {
      this.upsertJob(schedule);
    }

    const workflows = await this.prisma.workflow.findMany({
      where: { isActive: true, cronExpr: { not: null } },
    });
    const keepWorkflows = new Set(workflows.map((workflow) => workflow.id));
    for (const workflowId of [...this.workflowJobs.keys()]) {
      if (!keepWorkflows.has(workflowId)) {
        this.removeWorkflowJob(workflowId);
      }
    }
    for (const workflow of workflows) {
      this.upsertWorkflowJob(workflow);
    }

    serviceLogger.info(
      ServiceType.SCHEDULER,
      `Loaded ${schedules.length} active schedule(s) and ${workflows.length} workflow schedule(s) into memory`
    );
  }

  private async syncWorkflow(workflowId: string, deleted: boolean): Promise<void> {
    if (deleted) {
      this.removeWorkflowJob(workflowId);
      return;
    }
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) {
      this.removeWorkflowJob(workflowId);
      return;
    }
    this.upsertWorkflowJob(workflow);
  }

  private upsertWorkflowJob(
    workflow: Pick<Workflow, "id" | "name" | "isActive" | "cronExpr">
  ): void {
    this.removeWorkflowJob(workflow.id);
    if (!isWorkflowEligible(workflow)) {
      return;
    }

    const context: WorkflowJobContext = { workflowId: workflow.id, name: workflow.name };
    const job = new Cron<WorkflowJobContext>(
      workflow.cronExpr,
      {
        name: `workflow:${workflow.id}`,
        timezone: getServerTimezone(),
        mode: CRON_PATTERN_MODE,
        protect: true,
        context,
        catch: (err) => {
          serviceLogger.error(
            ServiceType.SCHEDULER,
            `Workflow ${workflow.id} (${workflow.name}) callback failed: ${String(err)}`
          );
        },
      },
      async (self, ctx) => {
        let result;
        try {
          result = await this.triggerService.triggerWorkflow(ctx.workflowId);
        } catch (err) {
          if (err instanceof WorkflowStartError) {
            serviceLogger.warn(
              ServiceType.SCHEDULER,
              `Workflow ${ctx.workflowId} (${ctx.name}) not started: ${err.message}`
            );
            return;
          }
          throw err;
        }

        await this.prisma.workflow.update({
          where: { id: ctx.workflowId },
          data: { lastRunAt: new Date(), nextRunAt: self.nextRun() },
        });

        serviceLogger.info(
          ServiceType.SCHEDULER,
          `Workflow ${ctx.workflowId} (${ctx.name}) fired, workflowRunId=${result.workflowRunId} started=${result.started.length} skipped=${result.skipped.length}`
        );
      }
    );

    this.workflowJobs.set(workflow.id, job);
  }

  private removeWorkflowJob(workflowId: string): void {
    const job = this.workflowJobs.get(workflowId);
    if (!job) {
      return;
    }
    job.stop();
    this.workflowJobs.delete(workflowId);
  }

  private async syncSchedule(scheduleId: string): Promise<void> {
    const schedule = await this.prisma.pipelineSchedule.findUnique({
      where: { id: scheduleId },
      include: { pipeline: { select: { isActive: true } } },
    });

    if (!schedule || !isEligible(schedule)) {
      this.removeJob(scheduleId);
      return;
    }

    this.upsertJob(schedule);
  }

  private async syncPipeline(pipelineId: string, deleted: boolean): Promise<void> {
    if (deleted) {
      this.removeJobsForPipeline(pipelineId);
      return;
    }

    const pipeline = await this.prisma.pipeline.findUnique({
      where: { id: pipelineId },
      include: { schedules: true },
    });

    if (!pipeline || !pipeline.isActive) {
      this.removeJobsForPipeline(pipelineId);
      return;
    }

    for (const schedule of pipeline.schedules) {
      this.upsertJob({ ...schedule, pipeline: { isActive: pipeline.isActive } });
    }
  }

  private upsertJob(schedule: LoadedSchedule): void {
    if (!isEligible(schedule)) {
      this.removeJob(schedule.id);
      return;
    }

    this.removeJob(schedule.id);

    const timezone = getServerTimezone();
    const context: ScheduleJobContext = {
      scheduleId: schedule.id,
      pipelineId: schedule.pipelineId,
      name: schedule.name,
      inputContext: snapshotInputContext(schedule.inputContext),
    };

    const job = new Cron<ScheduleJobContext>(
      schedule.cronExpr,
      {
        name: schedule.id,
        timezone,
        mode: CRON_PATTERN_MODE,
        protect: true,
        context,
        catch: (err) => {
          serviceLogger.error(
            ServiceType.SCHEDULER,
            `Schedule ${schedule.id} (${schedule.name}) callback failed: ${String(err)}`
          );
        },
      },
      async (self, ctx) => {
        const result = await this.triggerService.triggerPipeline(ctx.pipelineId, {
          triggeredBy: "scheduler",
          scheduleId: ctx.scheduleId,
          scheduleInputContext: ctx.inputContext,
          context: {
            scheduleId: ctx.scheduleId,
            scheduleName: ctx.name,
          },
        });

        if (result.skipped) {
          serviceLogger.warn(
            ServiceType.SCHEDULER,
            `Schedule ${ctx.scheduleId} (${ctx.name}) skipped: ${result.skipReason}`
          );
          return;
        }

        await this.prisma.pipelineSchedule.update({
          where: { id: ctx.scheduleId },
          data: {
            lastRunAt: new Date(),
            nextRunAt: self.nextRun(),
          },
        });

        serviceLogger.info(
          ServiceType.SCHEDULER,
          `Schedule ${ctx.scheduleId} (${ctx.name}) fired, executionId=${result.executionId}`
        );
      }
    );

    this.jobs.set(schedule.id, job);
  }

  private removeJob(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (!job) {
      return;
    }
    job.stop();
    this.jobs.delete(scheduleId);
  }

  private removeJobsForPipeline(pipelineId: string): void {
    const ids = [...this.jobs.entries()]
      .filter(([, job]) => job.options.context?.pipelineId === pipelineId)
      .map(([scheduleId]) => scheduleId);
    for (const scheduleId of ids) {
      this.removeJob(scheduleId);
    }
  }
}
