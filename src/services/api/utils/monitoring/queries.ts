import { PipelineExecutionStatus, Prisma, PrismaClient, StepExecutionStatus } from "@db/client";
import {
  ACTIVE_STEP_STATUSES,
  evaluateStepRetryEligibility,
  type RetryBlockedReason,
} from "@/shared/pipeline/retryEligibility.ts";

export type StepExecutionWithRetryMeta = {
  id: string;
  executionId: string;
  stepId: string;
  status: StepExecutionStatus;
  attemptNumber: number;
  stepSnapshot: unknown;
  retryable: boolean;
  retryBlockedReason: RetryBlockedReason | null;
};

export class MonitoringQueries {
  constructor(private prisma: PrismaClient) {}

  // ============================================================
  // LAYER 1: Developer — execution detail drill-down
  // ============================================================

  /** Full timeline for a single pipeline run, from top to raw logs */
  async getExecutionDetail(executionId: string) {
    const detail = await this.prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        pipeline: {
          include: {
            steps: { orderBy: { stepOrder: "asc" } },
          },
        },
        stepExecutions: {
          orderBy: [{ createdAt: "asc" }, { attemptNumber: "asc" }],
          include: {
            step: true,
            taskExecutions: { orderBy: { taskOrder: "asc" } },
          },
        },
        logs: {
          orderBy: { loggedAt: "asc" },
          take: 500, // Cap for very chatty pipelines
        },
      },
    });

    const currentStep = detail.pipeline.steps[detail.currentStepIndex];
    const currentStepId = currentStep?.id;

    const attemptsForCurrentStep = currentStepId
      ? detail.stepExecutions.filter((se) => se.stepId === currentStepId)
      : [];
    const latestAttempt = attemptsForCurrentStep.at(-1);
    const hasActiveAttempt = attemptsForCurrentStep.some((se) =>
      ACTIVE_STEP_STATUSES.includes(se.status)
    );

    const stepExecutions = detail.stepExecutions.map((se) => {
      const eligibility = evaluateStepRetryEligibility({
        execution: detail,
        attempt: se,
        currentStepId,
        latestAttemptId: latestAttempt?.id,
        hasActiveAttempt,
      });
      return {
        ...se,
        retryable: eligibility.retryable,
        retryBlockedReason: eligibility.retryBlockedReason,
      };
    });

    // Keep response shape compatible: pipeline without nested steps list
    const { steps, ...pipeline } = detail.pipeline;
    void steps;
    return {
      ...detail,
      pipeline,
      stepExecutions,
    };
  }

  /** Full detail for a single step execution including tasks and logs */
  async getStepExecutionDetail(stepExecutionId: string) {
    return this.prisma.stepExecution.findUniqueOrThrow({
      where: { id: stepExecutionId },
      include: {
        step: true,
        execution: { select: { id: true, pipelineId: true, status: true } },
        taskExecutions: { orderBy: { taskOrder: "asc" } },
        logs: { orderBy: { loggedAt: "asc" } },
      },
    });
  }

  /** Full detail for a single task execution with its logs */
  async getTaskExecutionDetail(taskExecutionId: string) {
    return this.prisma.taskExecution.findUniqueOrThrow({
      where: { id: taskExecutionId },
      include: {
        stepExecution: { select: { id: true, executionId: true, stepId: true, status: true } },
        logs: { orderBy: { loggedAt: "asc" } },
      },
    });
  }

  /** All logs for a specific task execution */
  async getTaskExecutionLogs(taskExecutionId: string) {
    return this.prisma.executionLog.findMany({
      where: { taskExecutionId },
      orderBy: { loggedAt: "asc" },
    });
  }

  /** Logs for a specific step attempt, interleaved with task-level logs */
  async getStepExecutionLogs(stepExecutionId: string) {
    return this.prisma.executionLog.findMany({
      where: { stepExecutionId },
      orderBy: { loggedAt: "asc" },
    });
  }

  /** All attempts for a given step within an execution — useful for retry inspection */
  async getStepAttempts(executionId: string, stepId: string) {
    return this.prisma.stepExecution.findMany({
      where: { executionId, stepId },
      orderBy: { attemptNumber: "asc" },
      include: {
        taskExecutions: { orderBy: { taskOrder: "asc" } },
      },
    });
  }

  // ============================================================
  // LAYER 2: Operator — live dashboard counts
  // ============================================================

  /** Current system health snapshot */
  async getDashboardSummary() {
    const [statusCounts, stuckExecutions, recentFailures] = await Promise.all([
      // Count executions by status
      this.prisma.pipelineExecution.groupBy({
        by: ["status"],
        _count: { id: true },
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // last 24h
        },
      }),

      // Pipelines stuck in AWAITING_STEP for more than 10 minutes
      this.prisma.pipelineExecution.findMany({
        where: {
          status: PipelineExecutionStatus.AWAITING_STEP,
          updatedAt: { lte: new Date(Date.now() - 10 * 60 * 1000) },
        },
        include: { pipeline: { select: { name: true } } },
        orderBy: { updatedAt: "asc" },
      }),

      // Most recently failed executions
      this.prisma.pipelineExecution.findMany({
        where: { status: PipelineExecutionStatus.FAILED },
        orderBy: { finishedAt: "desc" },
        take: 10,
        include: {
          pipeline: { select: { name: true } },
          stepExecutions: {
            where: { status: "FAILED" },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { step: { select: { name: true } } },
          },
        },
      }),
    ]);

    const counts = Object.fromEntries(statusCounts.map((r) => [r.status, r._count.id]));

    return {
      last24h: {
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        completed: counts["COMPLETED"] ?? 0,
        failed: counts["FAILED"] ?? 0,
        running: counts["RUNNING"] ?? 0,
        awaitingStep: counts["AWAITING_STEP"] ?? 0,
      },
      stuckExecutions,
      recentFailures,
    };
  }

  /** Paginated list of recent executions for the main monitoring table */
  async listExecutions(opts: {
    pipelineId?: string;
    status?: PipelineExecutionStatus;
    page?: number;
    pageSize?: number;
  }) {
    const { pipelineId, status, page = 1, pageSize = 25 } = opts;

    const where = {
      ...(pipelineId ? { pipelineId } : {}),
      ...(status ? { status } : {}),
    };

    const [executions, total] = await Promise.all([
      this.prisma.pipelineExecution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          pipeline: { select: { name: true } },
        },
      }),
      this.prisma.pipelineExecution.count({ where }),
    ]);

    return {
      executions,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    };
  }

  // ============================================================
  // LAYER 3: Reporter — analytics and historical trends
  // ============================================================

  /** Daily success/failure counts over a date range */
  async getDailyTrends(opts: { pipelineId?: string; days?: number }) {
    const { pipelineId, days = 30 } = opts;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Raw SQL for date truncation — Prisma doesn't expose date_trunc directly
    const rows = await this.prisma.$queryRaw<{ date: Date; status: string; count: bigint }[]>`
      SELECT
        DATE_TRUNC('day', "createdAt") AS date,
        status,
        COUNT(*) AS count
      FROM pipeline_executions
      WHERE "createdAt" >= ${since.toDateString()}
        ${pipelineId ? Prisma.sql`AND "pipelineId" = ${pipelineId}` : Prisma.empty}
      GROUP BY DATE_TRUNC('day', "createdAt"), status
      ORDER BY date ASC
    `;

    return rows.map((r) => ({
      date: r.date.toDateString(),
      status: r.status,
      count: Number(r.count),
    }));
  }

  /** Which steps fail most often, across all pipelines */
  async getTopFailingSteps(opts: { days?: number; limit?: number }) {
    const { days = 7, limit = 10 } = opts;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<
      { step_name: string; pipeline_name: string; failure_count: bigint; avg_attempts: number }[]
    >`
      SELECT
        ps.name           AS step_name,
        p.name            AS pipeline_name,
        COUNT(*)          AS failure_count,
        AVG(se."attemptNumber") AS avg_attempts
      FROM step_executions se
      JOIN pipeline_steps ps ON ps.id = se."stepId"
      JOIN pipelines p ON p.id = ps."pipelineId"
      WHERE se.status = 'FAILED'
        AND se."createdAt" >= ${since.toDateString()}
      GROUP BY ps.id, ps.name, p.name
      ORDER BY failure_count DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      stepName: r.step_name,
      pipelineName: r.pipeline_name,
      failureCount: Number(r.failure_count),
      avgAttempts: Number(r.avg_attempts.toFixed(1)),
    }));
  }

  /** Average pipeline duration per pipeline, completed runs only */
  async getPipelineDurations(days = 7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<
      { pipeline_name: string; avg_duration_s: number; p95_duration_s: number; run_count: bigint }[]
    >`
      SELECT
        p.name AS pipeline_name,
        AVG(EXTRACT(EPOCH FROM (pe."finishedAt" - pe."startedAt"))) AS avg_duration_s,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (pe."finishedAt" - pe."startedAt"))
        ) AS p95_duration_s,
        COUNT(*) AS run_count
      FROM pipeline_executions pe
      JOIN pipelines p ON p.id = pe."pipelineId"
      WHERE pe.status = 'COMPLETED'
        AND pe."startedAt" IS NOT NULL
        AND pe."finishedAt" IS NOT NULL
        AND pe."createdAt" >= ${since}
      GROUP BY p.id, p.name
      ORDER BY avg_duration_s DESC
    `;

    return rows.map((r) => ({
      pipelineName: r.pipeline_name,
      avgDurationSeconds: Math.round(r.avg_duration_s),
      p95DurationSeconds: Math.round(r.p95_duration_s),
      runCount: Number(r.run_count),
    }));
  }

  /** Most common error messages across all failed step executions */
  async getTopErrors(days = 7, limit = 10) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<{ error_message: string; occurrence_count: bigint }[]>`
      SELECT
        "errorMessage",
        COUNT(*) AS occurrence_count
      FROM step_executions
      WHERE status = 'FAILED'
        AND "errorMessage" IS NOT NULL
        AND "createdAt" >= ${since}
      GROUP BY "errorMessage"
      ORDER BY occurrence_count DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      errorMessage: r.error_message,
      occurrenceCount: Number(r.occurrence_count),
    }));
  }
}
