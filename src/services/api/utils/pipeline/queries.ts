import {
  PrismaClient,
  Prisma,
  PipelineExecutionStatus,
  ConcurrencyPolicy,
  ScheduleStatus,
} from "@db/client";
import { Cron } from "croner";
import { CRON_PATTERN_MODE } from "@/shared/utils/cron.ts";
import { getServerTimezone } from "@/shared/utils/timezone.ts";

export class PipelineQueries {
  constructor(private prisma: PrismaClient) {}

  // ============================================================
  // Pipelines
  // ============================================================

  async listPipelines(opts: { isActive?: boolean; page?: number; pageSize?: number }) {
    const { isActive, page = 1, pageSize = 25 } = opts;

    const where = isActive !== undefined ? { isActive } : {};

    const [pipelines, total] = await Promise.all([
      this.prisma.pipeline.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { steps: true, executions: true, schedules: true } },
          workflow: { select: { id: true, name: true } },
        },
      }),
      this.prisma.pipeline.count({ where }),
    ]);

    return {
      pipelines,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    };
  }

  async getPipeline(id: string) {
    return this.prisma.pipeline.findUniqueOrThrow({
      where: { id },
      include: {
        steps: { orderBy: { stepOrder: "asc" } },
        schedules: { orderBy: { createdAt: "asc" } },
        workflow: { select: { id: true, name: true } },
      },
    });
  }

  /** Copy a pipeline and its steps under a new name; schedules, connectors and workflow stay behind. */
  async duplicatePipeline(id: string, name: string) {
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.pipeline.findUniqueOrThrow({
        where: { id },
        include: { steps: { orderBy: { stepOrder: "asc" } } },
      });
      return tx.pipeline.create({
        data: {
          name,
          description: source.description,
          config: source.config as Prisma.InputJsonValue,
          isActive: source.isActive,
          concurrencyPolicy: source.concurrencyPolicy,
          steps: {
            create: source.steps.map((step) => ({
              name: step.name,
              description: step.description,
              handlerKey: step.handlerKey,
              stepOrder: step.stepOrder,
              maxRetries: step.maxRetries,
              retryDelayMs: step.retryDelayMs,
              inputSchema: step.inputSchema ?? Prisma.DbNull,
              handlerConfig: step.handlerConfig as Prisma.InputJsonValue,
            })),
          },
        },
      });
    });
  }

  async createPipeline(data: {
    name: string;
    description?: string;
    config?: Record<string, unknown>;
    isActive?: boolean;
    concurrencyPolicy?: ConcurrencyPolicy;
  }) {
    return this.prisma.pipeline.create({
      data: {
        ...data,
        config: data.config as Prisma.InputJsonObject | undefined,
      },
    });
  }

  async updatePipeline(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      config?: Record<string, unknown>;
      isActive?: boolean;
      concurrencyPolicy?: ConcurrencyPolicy;
    }
  ) {
    return this.prisma.pipeline.update({
      where: { id },
      data: {
        ...data,
        config: data.config as Prisma.InputJsonObject | undefined,
      },
    });
  }

  async deletePipeline(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const activeCount = await tx.pipelineExecution.count({
        where: {
          pipelineId: id,
          status: {
            in: [
              PipelineExecutionStatus.PENDING,
              PipelineExecutionStatus.RUNNING,
              PipelineExecutionStatus.AWAITING_STEP,
            ],
          },
        },
      });

      if (activeCount > 0) {
        throw new ActiveExecutionError(
          `Cannot delete pipeline: ${activeCount} active execution(s) in progress`
        );
      }

      // Connectors from other pipelines would lose their target; the user removes them first
      const incomingConnectors = await tx.pipelineConnector.findMany({
        where: {
          OR: [{ targetPipelineId: id }, { otherwisePipelineId: id }],
          sourcePipelineId: { not: id },
        },
        select: { id: true, name: true, sourcePipeline: { select: { id: true, name: true } } },
      });
      if (incomingConnectors.length > 0) {
        throw new IncomingConnectorsError(
          `Cannot delete pipeline: ${incomingConnectors.length} connector(s) from other pipelines start it`,
          incomingConnectors
        );
      }

      // A merge would lose the pipeline it starts; the user changes or deletes it first
      const mergeCount = await tx.pipelineMerge.count({ where: { targetPipelineId: id } });
      if (mergeCount > 0) {
        throw new IncomingConnectorsError(
          `Cannot delete pipeline: ${mergeCount} connector(s) that wait for several pipelines start it`,
          []
        );
      }

      return tx.pipeline.delete({ where: { id } });
    });
  }

  // ============================================================
  // Steps
  // ============================================================

  async listSteps(pipelineId: string) {
    return this.prisma.pipelineStep.findMany({
      where: { pipelineId },
      orderBy: { stepOrder: "asc" },
    });
  }

  async getStep(stepId: string) {
    return this.prisma.pipelineStep.findUniqueOrThrow({
      where: { id: stepId },
    });
  }

  async createStep(
    pipelineId: string,
    data: {
      name: string;
      description?: string;
      handlerKey: string;
      stepOrder: number;
      maxRetries?: number;
      retryDelayMs?: number;
      inputSchema?: unknown;
      handlerConfig?: Record<string, unknown>;
    }
  ) {
    return this.prisma.pipelineStep.create({
      data: {
        ...data,
        pipelineId,
        inputSchema: data.inputSchema as Prisma.InputJsonValue | undefined,
        handlerConfig: data.handlerConfig as Prisma.InputJsonObject | undefined,
      },
    });
  }

  async updateStep(
    stepId: string,
    data: {
      name?: string;
      description?: string | null;
      handlerKey?: string;
      stepOrder?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      inputSchema?: unknown;
      handlerConfig?: Record<string, unknown>;
    }
  ) {
    return this.prisma.pipelineStep.update({
      where: { id: stepId },
      data: {
        ...data,
        inputSchema: data.inputSchema as Prisma.InputJsonValue | undefined,
        handlerConfig: data.handlerConfig as Prisma.InputJsonObject | undefined,
      },
    });
  }

  async deleteStep(stepId: string) {
    return this.prisma.pipelineStep.delete({ where: { id: stepId } });
  }

  // ============================================================
  // Schedules
  // ============================================================

  async listSchedules(pipelineId: string) {
    return this.prisma.pipelineSchedule.findMany({
      where: { pipelineId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getSchedule(id: string) {
    return this.prisma.pipelineSchedule.findUniqueOrThrow({
      where: { id },
      include: { pipeline: { select: { id: true, name: true } } },
    });
  }

  async createSchedule(
    pipelineId: string,
    data: {
      name: string;
      description?: string;
      cronExpr: string;
      inputContext?: Record<string, unknown>;
    }
  ) {
    return this.prisma.pipelineSchedule.create({
      data: {
        pipelineId,
        name: data.name,
        description: data.description,
        cronExpr: data.cronExpr,
        inputContext: data.inputContext as Prisma.InputJsonObject | undefined,
        nextRunAt: computeNextRunAt(data.cronExpr),
      },
    });
  }

  async updateSchedule(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      cronExpr?: string;
      inputContext?: Record<string, unknown>;
    }
  ) {
    return this.prisma.pipelineSchedule.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        cronExpr: data.cronExpr,
        inputContext: data.inputContext as Prisma.InputJsonObject | undefined,
        nextRunAt: data.cronExpr !== undefined ? computeNextRunAt(data.cronExpr) : undefined,
      },
    });
  }

  async deleteSchedule(id: string) {
    return this.prisma.pipelineSchedule.delete({ where: { id } });
  }

  async pauseSchedule(id: string) {
    return this.prisma.pipelineSchedule.update({
      where: { id },
      data: { status: ScheduleStatus.PAUSED },
    });
  }

  async resumeSchedule(id: string) {
    return this.prisma.pipelineSchedule.update({
      where: { id },
      data: { status: ScheduleStatus.ACTIVE },
    });
  }
}

function computeNextRunAt(cronExpr: string): Date | null {
  return new Cron(cronExpr, {
    timezone: getServerTimezone(),
    mode: CRON_PATTERN_MODE,
    paused: true,
  }).nextRun();
}

export class ActiveExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActiveExecutionError";
  }
}

export class IncomingConnectorsError extends Error {
  constructor(
    message: string,
    readonly connectors: {
      id: string;
      name: string;
      sourcePipeline: { id: string; name: string };
    }[]
  ) {
    super(message);
    this.name = "IncomingConnectorsError";
  }
}
