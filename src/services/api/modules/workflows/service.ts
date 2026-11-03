import { Cron } from "croner";
import { ConnectorRunStatus, MergeRunStatus, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { badRequest, conflict, notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { CRON_PATTERN_MODE } from "@/shared/utils/cron.ts";
import { getServerTimezone } from "@/shared/utils/timezone.ts";
import {
  deriveWorkflowRunStatus,
  findEntryPipelineIds,
  mergeEdges,
  startWorkflow,
  WorkflowRunStatus,
  WorkflowStartError,
} from "@/shared/pipeline/workflows.ts";
import { runPeriodRangeSchema } from "@/shared/pipeline/runPeriod.ts";
import type {
  CreateWorkflowBody,
  ListWorkflowRunsQuery,
  RunWorkflowBody,
  UpdateWorkflowBody,
} from "@/services/api/modules/workflows/model.ts";

function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

function isPrismaDuplicate(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const workflowNotFound = () => notFound("Workflow not found", ApiErrorCode.WORKFLOW_NOT_FOUND);
const duplicateName = () =>
  conflict("A workflow with that name already exists", ApiErrorCode.WORKFLOW_DUPLICATE_NAME);

const pipelineRef = { select: { id: true, name: true, isActive: true } } as const;

/** When the schedule fires next; null for a workflow started by hand only. */
export function nextRunAt(cronExpr: string | null | undefined): Date | null {
  if (!cronExpr) return null;
  return new Cron(cronExpr, {
    timezone: getServerTimezone(),
    mode: CRON_PATTERN_MODE,
    paused: true,
  }).nextRun();
}

export type WorkflowRunSummary = {
  status: WorkflowRunStatus;
  executionCount: number;
  finishedAt: Date | null;
};

export class WorkflowService {
  async listWorkflows() {
    const workflows = await apiDb.workflow.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { pipelines: true, runs: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, createdAt: true } },
      },
    });
    const summaries = await this.summarizeRuns(workflows.flatMap((w) => w.runs.map((r) => r.id)));
    return workflows.map(({ runs, ...workflow }) => ({
      ...workflow,
      latestRun: runs[0] ? { ...runs[0], ...summaries.get(runs[0].id)! } : null,
    }));
  }

  async getWorkflow(id: string) {
    const workflow = await apiDb.workflow.findUnique({
      where: { id },
      include: {
        pipelines: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            description: true,
            isActive: true,
            _count: { select: { steps: true } },
            steps: { orderBy: { stepOrder: "asc" } },
          },
        },
      },
    });
    if (!workflow) throw workflowNotFound();

    const memberIds = workflow.pipelines.map((p) => p.id);
    const connectors = await apiDb.pipelineConnector.findMany({
      where: { sourcePipelineId: { in: memberIds } },
      orderBy: { createdAt: "asc" },
      include: {
        sourcePipeline: pipelineRef,
        targetPipeline: pipelineRef,
        otherwisePipeline: pipelineRef,
      },
    });
    const merges = await apiDb.pipelineMerge.findMany({
      where: { workflowId: id },
      orderBy: { createdAt: "asc" },
      include: {
        targetPipeline: pipelineRef,
        sources: { include: { pipeline: pipelineRef } },
      },
    });
    const entryPipelineIds = findEntryPipelineIds(memberIds, [
      ...connectors.filter((c) => c.isActive),
      ...mergeEdges(merges.filter((m) => m.isActive)),
    ]);

    return { ...workflow, connectors, merges, entryPipelineIds };
  }

  async createWorkflow(body: CreateWorkflowBody) {
    try {
      return await apiDb.workflow.create({
        data: { ...body, nextRunAt: nextRunAt(body.cronExpr) },
      });
    } catch (err) {
      if (isPrismaDuplicate(err)) throw duplicateName();
      throw err;
    }
  }

  async updateWorkflow(id: string, body: UpdateWorkflowBody) {
    try {
      return await apiDb.workflow.update({
        where: { id },
        data: {
          ...body,
          ...(body.cronExpr !== undefined ? { nextRunAt: nextRunAt(body.cronExpr) } : {}),
        },
      });
    } catch (err) {
      if (isPrismaNotFound(err)) throw workflowNotFound();
      if (isPrismaDuplicate(err)) throw duplicateName();
      throw err;
    }
  }

  /** Its pipelines stay, no longer in a workflow; its runs go. */
  async deleteWorkflow(id: string) {
    try {
      return await apiDb.workflow.delete({ where: { id } });
    } catch (err) {
      if (isPrismaNotFound(err)) throw workflowNotFound();
      throw err;
    }
  }

  async addPipeline(id: string, pipelineId: string) {
    const [workflow, pipeline] = await Promise.all([
      apiDb.workflow.findUnique({ where: { id }, select: { id: true } }),
      apiDb.pipeline.findUnique({
        where: { id: pipelineId },
        select: { id: true, workflowId: true, workflow: { select: { name: true } } },
      }),
    ]);
    if (!workflow) throw workflowNotFound();
    if (!pipeline) throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
    if (pipeline.workflowId && pipeline.workflowId !== id) {
      throw conflict(
        `Pipeline is already in the workflow "${pipeline.workflow?.name ?? pipeline.workflowId}"`,
        ApiErrorCode.PIPELINE_IN_OTHER_WORKFLOW,
        { workflowId: pipeline.workflowId }
      );
    }
    // Guarded so a concurrent add to another workflow cannot be overwritten
    const updated = await apiDb.pipeline.updateMany({
      where: { id: pipelineId, OR: [{ workflowId: null }, { workflowId: id }] },
      data: { workflowId: id },
    });
    if (updated.count === 0) {
      throw conflict(
        "Pipeline is already in another workflow",
        ApiErrorCode.PIPELINE_IN_OTHER_WORKFLOW
      );
    }
    return this.getWorkflow(id);
  }

  async removePipeline(id: string, pipelineId: string) {
    const usedBy = await apiDb.pipelineMerge.findFirst({
      where: {
        workflowId: id,
        OR: [{ targetPipelineId: pipelineId }, { sources: { some: { pipelineId } } }],
      },
      select: { name: true },
    });
    if (usedBy) {
      throw conflict(
        `Pipeline is used by the connector "${usedBy.name}"; change or delete that connector first`,
        ApiErrorCode.PIPELINE_IN_MERGE
      );
    }
    const removed = await apiDb.pipeline.updateMany({
      where: { id: pipelineId, workflowId: id },
      data: { workflowId: null },
    });
    if (removed.count === 0) {
      throw notFound("Pipeline is not in this workflow", ApiErrorCode.PIPELINE_NOT_IN_WORKFLOW);
    }
    return this.getWorkflow(id);
  }

  async runWorkflow(id: string, body: RunWorkflowBody = {}) {
    let period;
    if (body.period) {
      const parsed = runPeriodRangeSchema.safeParse(body.period);
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues[0]?.message ?? "Invalid period range",
          ApiErrorCode.WORKFLOW_RUN_PERIOD_INVALID,
          parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        );
      }
      period = parsed.data;
    }
    try {
      return await startWorkflow(apiDb, id, { triggeredBy: "api", period });
    } catch (err) {
      if (err instanceof WorkflowStartError) {
        if (err.reason === "not_found") throw workflowNotFound();
        throw conflict(
          err.message,
          err.reason === "inactive" ? ApiErrorCode.WORKFLOW_INACTIVE : ApiErrorCode.WORKFLOW_EMPTY
        );
      }
      throw err;
    }
  }

  async listRuns(id: string, query: ListWorkflowRunsQuery) {
    const workflow = await apiDb.workflow.findUnique({ where: { id }, select: { id: true } });
    if (!workflow) throw workflowNotFound();

    const [runs, total] = await Promise.all([
      apiDb.workflowRun.findMany({
        where: { workflowId: id },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      apiDb.workflowRun.count({ where: { workflowId: id } }),
    ]);
    const summaries = await this.summarizeRuns(runs.map((r) => r.id));
    return {
      items: runs.map((run) => ({ ...run, ...summaries.get(run.id)! })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getRun(runId: string) {
    const run = await apiDb.workflowRun.findUnique({
      where: { id: runId },
      include: {
        workflow: { select: { id: true, name: true } },
        executions: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            triggeredBy: true,
            chainDepth: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
            pipeline: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!run) {
      throw notFound("Workflow run not found", ApiErrorCode.WORKFLOW_RUN_NOT_FOUND);
    }
    // Connectors still deciding (e.g. in their delay) keep the run going
    const waitingConnectorRuns = await apiDb.connectorRun.findMany({
      where: { status: ConnectorRunStatus.WAITING, sourceExecution: { workflowRunId: runId } },
      orderBy: { checkAt: "asc" },
      select: {
        id: true,
        checkAt: true,
        sourceExecutionId: true,
        connector: { select: { id: true, name: true, targetPipeline: { select: { name: true } } } },
      },
    });
    const mergeRuns = await apiDb.mergeRun.findMany({
      where: { workflowRunId: runId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        reason: true,
        deadlineAt: true,
        evaluatedAt: true,
        targetExecutionId: true,
        merge: { select: { id: true, name: true, targetPipeline: { select: { name: true } } } },
        arrivals: { select: { pipelineId: true, status: true } },
      },
    });
    // Every connector decision in this run, so the diagram can colour each connector
    const connectorRuns = await apiDb.connectorRun.findMany({
      where: { sourceExecution: { workflowRunId: runId } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        connectorId: true,
        status: true,
        reason: true,
        startedOtherwise: true,
        targetExecutionId: true,
      },
    });
    const summary = await this.summarizeRuns([runId]);
    return { ...run, ...summary.get(runId)!, waitingConnectorRuns, connectorRuns, mergeRuns };
  }

  /** Status, size and end time of each run, from its executions and waiting connectors. */
  private async summarizeRuns(runIds: string[]): Promise<Map<string, WorkflowRunSummary>> {
    const summaries = new Map<string, WorkflowRunSummary>();
    if (runIds.length === 0) return summaries;

    const [executions, waiting, waitingMerges] = await Promise.all([
      apiDb.pipelineExecution.findMany({
        where: { workflowRunId: { in: runIds } },
        select: { workflowRunId: true, status: true, finishedAt: true },
      }),
      apiDb.connectorRun.findMany({
        where: {
          status: ConnectorRunStatus.WAITING,
          sourceExecution: { workflowRunId: { in: runIds } },
        },
        select: { sourceExecution: { select: { workflowRunId: true } } },
      }),
      apiDb.mergeRun.findMany({
        where: { status: MergeRunStatus.WAITING, workflowRunId: { in: runIds } },
        select: { workflowRunId: true },
      }),
    ]);

    for (const runId of runIds) {
      const own = executions.filter((e) => e.workflowRunId === runId);
      const waitingCount =
        waiting.filter((w) => w.sourceExecution.workflowRunId === runId).length +
        waitingMerges.filter((m) => m.workflowRunId === runId).length;
      const status = deriveWorkflowRunStatus(
        own.map((e) => e.status),
        waitingCount
      );
      const ends = own.map((e) => e.finishedAt?.getTime() ?? 0);
      summaries.set(runId, {
        status,
        executionCount: own.length,
        finishedAt:
          status === WorkflowRunStatus.RUNNING || own.length === 0
            ? null
            : new Date(Math.max(...ends)),
      });
    }
    return summaries;
  }
}
