import {
  LogLevel,
  Prisma,
  PipelineExecutionStatus,
  StepExecutionStatus,
  TaskExecutionStatus,
} from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { apiChannel } from "@/services/api/utils/amqp.ts";
import { MonitoringQueries } from "@/services/api/utils/monitoring/queries.ts";
import { StepRetryError, StepRetryService } from "@/services/api/utils/monitoring/retry.ts";
import { PipelineQueries } from "@/services/api/utils/pipeline/queries.ts";
import { validatePipelineInputContext } from "@/services/api/utils/pipeline/inputContextValidation.ts";
import { TriggerService } from "@/services/scheduler/trigger-service.ts";
import { replayDeadMessage } from "@/services/worker/services/monitor/monitor.ts";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import { enqueueOutboxMessage } from "@/shared/pipeline/outbox.ts";
import { apiError, badRequest, notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import type {
  ListExecutionsQuery,
  ListDeadLettersQuery,
  ReplayDeadLetterBody,
  TriggerPipelineBody,
  RetryStepExecutionBody,
} from "@/services/api/modules/monitoring/model.ts";

const ALLOWED_DEAD_LETTER_QUEUES: string[] = [
  QUEUES.PIPELINE_EXECUTIONS,
  QUEUES.STEP_RESULTS,
  ...Array.from(QUEUES.STEP.values()).map((s) => s.queueName),
];

const TERMINAL_EXECUTION_STATUSES: PipelineExecutionStatus[] = [
  PipelineExecutionStatus.COMPLETED,
  PipelineExecutionStatus.FAILED,
  PipelineExecutionStatus.CANCELLED,
];

const PAUSABLE_EXECUTION_STATUSES: PipelineExecutionStatus[] = [
  PipelineExecutionStatus.PENDING,
  PipelineExecutionStatus.RUNNING,
];

const ACTIVE_PIPELINE_EXECUTION_STATUSES: PipelineExecutionStatus[] = [
  PipelineExecutionStatus.PENDING,
  PipelineExecutionStatus.RUNNING,
  PipelineExecutionStatus.AWAITING_STEP,
];

function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

export class MonitoringService {
  // `apiDb` is assigned by initializeApiDb() after this module is imported, so these
  // instances must be constructed lazily on first use rather than at class-field-init time.
  private _queries?: MonitoringQueries;
  private _pipelineQueries?: PipelineQueries;
  private _retryService?: StepRetryService;
  private _triggerService?: TriggerService;

  private get queries(): MonitoringQueries {
    return (this._queries ??= new MonitoringQueries(apiDb));
  }
  private get pipelineQueries(): PipelineQueries {
    return (this._pipelineQueries ??= new PipelineQueries(apiDb));
  }
  private get retryService(): StepRetryService {
    return (this._retryService ??= new StepRetryService(apiDb));
  }
  private get triggerService(): TriggerService {
    return (this._triggerService ??= new TriggerService(apiDb));
  }

  async getDashboardSummary() {
    return this.queries.getDashboardSummary();
  }

  async listExecutions(query: ListExecutionsQuery) {
    return this.queries.listExecutions(query);
  }

  async getExecutionDetail(id: string) {
    try {
      return await this.queries.getExecutionDetail(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Execution not found", ApiErrorCode.EXECUTION_NOT_FOUND);
      }
      throw err;
    }
  }

  async getStepAttempts(id: string, stepId: string) {
    return this.queries.getStepAttempts(id, stepId);
  }

  async listDeadLetters(query: ListDeadLettersQuery) {
    const { pipelineId, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    const where = {
      message: "Dead letter received",
      ...(pipelineId ? { execution: { pipelineId } } : {}),
    };

    const [logs, total] = await Promise.all([
      apiDb.executionLog.findMany({
        where,
        orderBy: { loggedAt: "desc" },
        skip,
        take: pageSize,
        select: { id: true, executionId: true, metadata: true, loggedAt: true },
      }),
      apiDb.executionLog.count({ where }),
    ]);

    return {
      logs,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    };
  }

  async replayDeadLetter(body: ReplayDeadLetterBody) {
    const { executionId } = body;

    const execution = await apiDb.pipelineExecution.findUnique({ where: { id: executionId } });
    if (!execution) {
      throw notFound("Execution not found", ApiErrorCode.EXECUTION_NOT_FOUND);
    }

    const messageBody = JSON.parse(execution.inputContext);
    const targetQueue = messageBody.targetQueue;

    if (!ALLOWED_DEAD_LETTER_QUEUES.includes(targetQueue)) {
      throw badRequest(
        `Invalid targetQueue. Allowed queues: ${ALLOWED_DEAD_LETTER_QUEUES.join(", ")}`,
        ApiErrorCode.VALIDATION_ERROR
      );
    }

    replayDeadMessage(apiChannel(), targetQueue, messageBody);

    if (executionId) {
      await apiDb.pipelineExecution.update({
        where: { id: executionId },
        data: { status: PipelineExecutionStatus.PENDING, currentStepIndex: 0, finishedAt: null },
      });

      const replayedAt = new Date().toISOString();
      await apiDb.executionLog.create({
        data: {
          executionId,
          level: LogLevel.INFO,
          message: "Dead letter replayed via API",
          metadata: { targetQueue, replayedAt },
        },
      });
    }

    return { replayed: true, targetQueue, executionId: executionId ?? null };
  }

  async cancelExecution(id: string) {
    const execution = await apiDb.pipelineExecution.findUnique({ where: { id } });
    if (!execution) {
      throw notFound("Execution not found", ApiErrorCode.EXECUTION_NOT_FOUND);
    }
    if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
      throw badRequest(
        "Execution is already in a terminal state",
        ApiErrorCode.EXECUTION_INVALID_STATE
      );
    }

    const now = new Date();

    await apiDb.pipelineExecution.update({
      where: { id },
      data: { status: PipelineExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.taskExecution.updateMany({
      where: {
        stepExecution: { executionId: id },
        status: { in: [TaskExecutionStatus.PENDING, TaskExecutionStatus.RUNNING] },
      },
      data: { status: TaskExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.stepExecution.updateMany({
      where: {
        executionId: id,
        status: { in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING] },
      },
      data: { status: StepExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.executionLog.create({
      data: {
        executionId: id,
        level: LogLevel.WARN,
        message: "Execution cancelled via API",
        metadata: { cancelledAt: now.toISOString() },
      },
    });

    return { executionId: id, status: "CANCELLED" };
  }

  async pauseExecution(id: string) {
    const execution = await apiDb.pipelineExecution.findUnique({ where: { id } });
    if (!execution) {
      throw notFound("Execution not found", ApiErrorCode.EXECUTION_NOT_FOUND);
    }
    if (!PAUSABLE_EXECUTION_STATUSES.includes(execution.status)) {
      throw badRequest(
        `Execution cannot be paused from status ${execution.status}. Only PENDING or RUNNING executions can be paused.`,
        ApiErrorCode.EXECUTION_INVALID_STATE
      );
    }

    const now = new Date();

    await apiDb.pipelineExecution.update({
      where: { id },
      data: { status: PipelineExecutionStatus.PAUSED },
    });
    await apiDb.executionLog.create({
      data: {
        executionId: id,
        level: LogLevel.INFO,
        message: "Execution paused via API",
        metadata: { pausedAt: now.toISOString(), previousStatus: execution.status },
      },
    });

    return { executionId: id, status: "PAUSED" };
  }

  async resumeExecution(id: string) {
    const execution = await apiDb.pipelineExecution.findUnique({ where: { id } });
    if (!execution) {
      throw notFound("Execution not found", ApiErrorCode.EXECUTION_NOT_FOUND);
    }
    if (execution.status !== PipelineExecutionStatus.PAUSED) {
      throw badRequest(
        `Execution is not paused (current status: ${execution.status})`,
        ApiErrorCode.EXECUTION_INVALID_STATE
      );
    }

    const now = new Date();

    await apiDb.$transaction(async (tx) => {
      await tx.pipelineExecution.update({
        where: { id },
        data: { status: PipelineExecutionStatus.RUNNING },
      });
      await enqueueOutboxMessage(tx, {
        destination: QUEUES.PIPELINE_EXECUTIONS,
        payload: { executionId: id },
      });
      await tx.executionLog.create({
        data: {
          executionId: id,
          level: LogLevel.INFO,
          message: "Execution resumed via API",
          metadata: { resumedAt: now.toISOString() },
        },
      });
    });

    return { executionId: id, status: "RUNNING" };
  }

  async triggerPipeline(id: string, body: TriggerPipelineBody) {
    const contextError = await validatePipelineInputContext(this.pipelineQueries, id, body.context);
    if (contextError) {
      throw contextError;
    }

    try {
      const result = await this.triggerService.triggerPipeline(id, {
        triggeredBy: "api",
        context: body.context,
      });

      if (result.skipped) {
        throw badRequest(
          result.skipReason ?? "Pipeline execution skipped",
          ApiErrorCode.PIPELINE_TRIGGER_SKIPPED
        );
      }

      return result;
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      if (err instanceof Error && err.message.startsWith("Pipeline not found:")) {
        throw notFound(err.message, ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }

  async cancelPipelineExecutions(id: string) {
    const pipeline = await apiDb.pipeline.findUnique({ where: { id } });
    if (!pipeline) {
      throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
    }

    const activeExecutions = await apiDb.pipelineExecution.findMany({
      where: { pipelineId: id, status: { in: ACTIVE_PIPELINE_EXECUTION_STATUSES } },
      select: { id: true },
    });

    if (activeExecutions.length === 0) {
      return { cancelledCount: 0, executionIds: [] };
    }

    const executionIds = activeExecutions.map((e) => e.id);
    const now = new Date();

    await apiDb.pipelineExecution.updateMany({
      where: { id: { in: executionIds } },
      data: { status: PipelineExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.taskExecution.updateMany({
      where: {
        stepExecution: { executionId: { in: executionIds } },
        status: { in: [TaskExecutionStatus.PENDING, TaskExecutionStatus.RUNNING] },
      },
      data: { status: TaskExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.stepExecution.updateMany({
      where: {
        executionId: { in: executionIds },
        status: { in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING] },
      },
      data: { status: StepExecutionStatus.CANCELLED, finishedAt: now },
    });
    await apiDb.executionLog.createMany({
      data: executionIds.map((executionId) => ({
        executionId,
        level: LogLevel.WARN,
        message: "Cancelled via API",
        metadata: { cancelledAt: now.toISOString() },
      })),
    });

    return { cancelledCount: executionIds.length, executionIds };
  }

  async getStepExecutionDetail(id: string) {
    try {
      return await this.queries.getStepExecutionDetail(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Step execution not found", ApiErrorCode.STEP_EXECUTION_NOT_FOUND);
      }
      throw err;
    }
  }

  async getStepExecutionLogs(id: string) {
    return this.queries.getStepExecutionLogs(id);
  }

  async retryStepExecution(id: string, body: RetryStepExecutionBody) {
    try {
      return await this.retryService.retryStepExecution(id, body.idempotencyKey);
    } catch (err) {
      if (err instanceof StepRetryError) {
        throw apiError(err.status, err.code, err.message, err.details);
      }
      throw err;
    }
  }

  async getTaskExecutionDetail(id: string) {
    try {
      return await this.queries.getTaskExecutionDetail(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Task execution not found", ApiErrorCode.TASK_EXECUTION_NOT_FOUND);
      }
      throw err;
    }
  }

  async getTaskExecutionLogs(id: string) {
    return this.queries.getTaskExecutionLogs(id);
  }

  async getPipelineDurations(days: number) {
    return this.queries.getPipelineDurations(days);
  }

  async getTopErrors(days: number, limit: number) {
    return this.queries.getTopErrors(days, limit);
  }

  async getTopFailingSteps(days: number, limit: number) {
    return this.queries.getTopFailingSteps({ days, limit });
  }

  async getDailyTrends(days: number, pipelineId: string | undefined) {
    return this.queries.getDailyTrends({ days, pipelineId });
  }
}
