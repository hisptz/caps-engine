import { MergeTriggerRule, PipelineExecutionStatus } from "@db/client";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import { enqueueOutboxMessage, type OutboxTx } from "@/shared/pipeline/outbox.ts";
import { STEP_OUTPUTS_KEY } from "@/shared/pipeline/stepOutputs.ts";

// ============================================================
// Merges
// Inside a workflow run, wait for several source pipelines, then start one more.
// Every arrival (and the deadline) queues a decision on pipeline.connectors; the evaluator
// runs after the arrival's transaction commits, so the last one to run sees every source.
// ============================================================

/** Longest a merge may wait for its last source (7 days). */
export const MAX_MERGE_TIMEOUT_MINUTES = 7 * 24 * 60;

// Shape of a merge message on pipeline.connectors (connector runs use connectorRunId)
export interface MergeJobMessage {
  mergeRunId: string;
}

const MINUTE_MS = 60 * 1000;

/**
 * Count a finished execution towards every active merge of its workflow that waits for its pipeline.
 * The first arrival opens the merge run and queues its deadline; each arrival queues a decision.
 */
export async function recordMergeArrivals(
  tx: OutboxTx,
  args: {
    executionId: string;
    pipelineId: string;
    workflowRunId: string;
    status: PipelineExecutionStatus;
    now: Date;
  }
): Promise<string[]> {
  const merges = await tx.pipelineMerge.findMany({
    where: {
      isActive: true,
      workflow: { runs: { some: { id: args.workflowRunId } } },
      sources: { some: { pipelineId: args.pipelineId } },
    },
    select: { id: true, timeoutMinutes: true },
  });

  const runIds: string[] = [];
  for (const merge of merges) {
    const deadlineAt = new Date(args.now.getTime() + merge.timeoutMinutes * MINUTE_MS);
    const opened = await tx.mergeRun.createMany({
      data: [{ mergeId: merge.id, workflowRunId: args.workflowRunId, deadlineAt }],
      skipDuplicates: true,
    });
    const run = await tx.mergeRun.findUniqueOrThrow({
      where: { mergeId_workflowRunId: { mergeId: merge.id, workflowRunId: args.workflowRunId } },
      select: { id: true, deadlineAt: true },
    });

    // A source finishing again (e.g. after a retry) replaces its earlier arrival
    await tx.mergeArrival.upsert({
      where: { mergeRunId_pipelineId: { mergeRunId: run.id, pipelineId: args.pipelineId } },
      create: {
        mergeRunId: run.id,
        pipelineId: args.pipelineId,
        executionId: args.executionId,
        status: args.status,
      },
      update: { executionId: args.executionId, status: args.status },
    });

    if (opened.count > 0) {
      await enqueueOutboxMessage(tx, {
        destination: QUEUES.PIPELINE_CONNECTORS,
        availableAt: run.deadlineAt,
        payload: { mergeRunId: run.id } satisfies MergeJobMessage,
      });
    }
    await enqueueOutboxMessage(tx, {
      destination: QUEUES.PIPELINE_CONNECTORS,
      payload: { mergeRunId: run.id } satisfies MergeJobMessage,
    });
    runIds.push(run.id);
  }
  return runIds;
}

export type MergeArrivalState = { pipelineId: string; status: PipelineExecutionStatus };

export type MergeDecision =
  | { kind: "wait" }
  | { kind: "fail"; reason: string }
  | { kind: "time_out"; reason: string }
  /** Every source is in; evaluate the rule with this overall status */
  | { kind: "ready"; status: PipelineExecutionStatus };

/**
 * What a merge run should do now. ALL_SUCCEEDED fails as soon as a source fails; otherwise it
 * waits for every source until the deadline.
 */
export function decideMerge(args: {
  triggerRule: MergeTriggerRule;
  sources: { pipelineId: string; name: string }[];
  arrivals: MergeArrivalState[];
  deadlineAt: Date;
  now: Date;
}): MergeDecision {
  const arrived = new Map(args.arrivals.map((a) => [a.pipelineId, a.status]));
  const nameOf = (id: string) => args.sources.find((s) => s.pipelineId === id)?.name ?? id;
  const failed = args.sources
    .filter((s) => arrived.get(s.pipelineId) === PipelineExecutionStatus.FAILED)
    .map((s) => s.name);

  if (args.triggerRule === MergeTriggerRule.ALL_SUCCEEDED && failed.length > 0) {
    return { kind: "fail", reason: `Did not succeed: ${failed.join(", ")}` };
  }

  const missing = args.sources.filter((s) => !arrived.has(s.pipelineId));
  if (missing.length > 0) {
    if (args.now >= args.deadlineAt) {
      return {
        kind: "time_out",
        reason: `Did not finish in time: ${missing.map((s) => nameOf(s.pipelineId)).join(", ")}`,
      };
    }
    return { kind: "wait" };
  }

  return {
    kind: "ready",
    status: failed.length > 0 ? PipelineExecutionStatus.FAILED : PipelineExecutionStatus.COMPLETED,
  };
}

/**
 * One context for the merge's rule: every source's step results side by side. Step ids are
 * unique across pipelines, so `stepOutputs.<stepId>` paths stay unambiguous.
 */
export function mergeSourceContexts(contexts: unknown[]): Record<string, unknown> {
  const stepOutputs: Record<string, unknown> = {};
  for (const context of contexts) {
    if (context && typeof context === "object") {
      const outputs = (context as Record<string, unknown>)[STEP_OUTPUTS_KEY];
      if (outputs && typeof outputs === "object") {
        Object.assign(stepOutputs, outputs);
      }
    }
  }
  return { [STEP_OUTPUTS_KEY]: stepOutputs };
}
