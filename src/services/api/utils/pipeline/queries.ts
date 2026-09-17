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
        include: { _count: { select: { steps: true, executions: true, schedules: true } } },
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
      },
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
