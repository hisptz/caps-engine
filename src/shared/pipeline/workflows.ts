import { PipelineExecutionStatus, Prisma, type PrismaClient } from "@db/client";
import { ACTIVE_EXECUTION_STATUSES, startExecution } from "@/shared/pipeline/startExecution.ts";
import { periodOverrideForStep, type RunPeriodRange } from "@/shared/pipeline/runPeriod.ts";

// ============================================================
// Workflows
// A workflow's start launches its first pipelines together as one workflow run; connectors
// carry the run on to the other pipelines of the same workflow.
// ============================================================

export type WorkflowConnectorEdge = {
  sourcePipelineId: string;
  targetPipelineId: string;
  otherwisePipelineId: string | null;
};

/**
 * The pipelines a workflow starts with: members that no connector from another member starts
 * (as its target or its otherwise pipeline). Pass only active connectors.
 */
export function findEntryPipelineIds(
  memberIds: string[],
  connectors: WorkflowConnectorEdge[]
): string[] {
  const members = new Set(memberIds);
  const startedByAnother = new Set<string>();
  for (const connector of connectors) {
    if (!members.has(connector.sourcePipelineId)) continue;
    for (const target of [connector.targetPipelineId, connector.otherwisePipelineId]) {
      if (target && target !== connector.sourcePipelineId && members.has(target)) {
        startedByAnother.add(target);
      }
    }
  }
  return memberIds.filter((id) => !startedByAnother.has(id));
}

export const WorkflowRunStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  /** Nothing started: every first pipeline was skipped */
  SKIPPED: "SKIPPED",
} as const;
export type WorkflowRunStatus = (typeof WorkflowRunStatus)[keyof typeof WorkflowRunStatus];

const ACTIVE = new Set<PipelineExecutionStatus>(ACTIVE_EXECUTION_STATUSES);

/** Merges count as edges too: each source "starts" the merge's target. */
export function mergeEdges(
  merges: { targetPipelineId: string; sources: { pipelineId: string }[] }[]
): WorkflowConnectorEdge[] {
  return merges.flatMap((merge) =>
    merge.sources.map((source) => ({
      sourcePipelineId: source.pipelineId,
      targetPipelineId: merge.targetPipelineId,
      otherwisePipelineId: null,
    }))
  );
}

/**
 * A run is RUNNING while any of its executions is active or a connector or merge is still
 * waiting to decide; then FAILED if any execution failed, CANCELLED if any was cancelled,
 * else COMPLETED.
 */
export function deriveWorkflowRunStatus(
  executionStatuses: PipelineExecutionStatus[],
  waitingDecisions: number
): WorkflowRunStatus {
  if (executionStatuses.length === 0) return WorkflowRunStatus.SKIPPED;
  if (waitingDecisions > 0 || executionStatuses.some((s) => ACTIVE.has(s))) {
    return WorkflowRunStatus.RUNNING;
  }
  if (executionStatuses.includes(PipelineExecutionStatus.FAILED)) return WorkflowRunStatus.FAILED;
  if (executionStatuses.includes(PipelineExecutionStatus.CANCELLED)) {
    return WorkflowRunStatus.CANCELLED;
  }
  return WorkflowRunStatus.COMPLETED;
}

export class WorkflowStartError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "inactive" | "empty"
  ) {
    super(message);
    this.name = "WorkflowStartError";
  }
}

export type SkippedWorkflowStart = { pipelineId: string; pipelineName: string; reason: string };

/** A step that keeps its own window in a fixed-range run, with why */
export type StepOutsideRange = { pipelineName: string; stepName: string; reason: string };

export type StartWorkflowResult = {
  workflowRunId: string;
  started: { pipelineId: string; executionId: string }[];
  skipped: SkippedWorkflowStart[];
  outsideRange: StepOutsideRange[];
};

/**
 * Run context for one first pipeline: per-step overrides so its data steps cover the range.
 * Pipelines started later by connectors run on their own settings.
 */
export function rangeContext(
  pipeline: {
    name: string;
    steps: { id: string; name: string; handlerKey: string; handlerConfig: unknown }[];
  },
  range: RunPeriodRange
): { context: Record<string, unknown>; outsideRange: StepOutsideRange[] } {
  const steps: Record<string, unknown> = {};
  const outsideRange: StepOutsideRange[] = [];
  for (const step of pipeline.steps) {
    const result = periodOverrideForStep(step, range);
    if (result.kind === "override") steps[step.id] = result.override;
    if (result.kind === "mismatch") {
      outsideRange.push({
        pipelineName: pipeline.name,
        stepName: step.name,
        reason: result.reason,
      });
    }
  }
  return { context: { steps }, outsideRange };
}

/** Start a workflow's first pipelines together, as one workflow run. */
export async function startWorkflow(
  prisma: PrismaClient,
  workflowId: string,
  opts: { triggeredBy: "scheduler" | "api"; period?: RunPeriodRange }
): Promise<StartWorkflowResult> {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findUnique({
      where: { id: workflowId },
      include: {
        pipelines: {
          select: {
            id: true,
            name: true,
            steps: {
              select: { id: true, name: true, handlerKey: true, handlerConfig: true },
              orderBy: { stepOrder: "asc" },
            },
          },
          orderBy: { name: "asc" },
        },
      },
    });
    if (!workflow) {
      throw new WorkflowStartError("Workflow not found", "not_found");
    }
    if (!workflow.isActive) {
      throw new WorkflowStartError("Workflow is inactive", "inactive");
    }
    if (workflow.pipelines.length === 0) {
      throw new WorkflowStartError("Workflow has no pipelines to start", "empty");
    }

    const memberIds = workflow.pipelines.map((p) => p.id);
    const [connectors, merges] = await Promise.all([
      tx.pipelineConnector.findMany({
        where: { isActive: true, sourcePipelineId: { in: memberIds } },
        select: { sourcePipelineId: true, targetPipelineId: true, otherwisePipelineId: true },
      }),
      tx.pipelineMerge.findMany({
        where: { workflowId, isActive: true },
        select: { targetPipelineId: true, sources: { select: { pipelineId: true } } },
      }),
    ]);
    const entryIds = new Set(
      findEntryPipelineIds(memberIds, [...connectors, ...mergeEdges(merges)])
    );

    const run = await tx.workflowRun.create({
      data: {
        workflowId,
        triggeredBy: opts.triggeredBy,
        period: opts.period ?? Prisma.DbNull,
      },
    });

    const started: StartWorkflowResult["started"] = [];
    const skipped: SkippedWorkflowStart[] = [];
    const outsideRange: StepOutsideRange[] = [];
    for (const pipeline of workflow.pipelines.filter((p) => entryIds.has(p.id))) {
      const range = opts.period ? rangeContext(pipeline, opts.period) : undefined;
      if (range) outsideRange.push(...range.outsideRange);
      const result = await startExecution(tx, pipeline.id, {
        triggeredBy: "workflow",
        workflowRun: { id: run.id, workflowId },
        context: range?.context,
      });
      if (result.skipped) {
        skipped.push({
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          reason: result.skipReason ?? "Skipped",
        });
      } else {
        started.push({ pipelineId: pipeline.id, executionId: result.executionId });
      }
    }

    if (skipped.length > 0) {
      await tx.workflowRun.update({
        where: { id: run.id },
        data: { skipped: skipped as Prisma.InputJsonArray },
      });
    }

    return { workflowRunId: run.id, started, skipped, outsideRange };
  });
}
