import { LogLevel, MergeRunStatus, type PrismaClient } from "@db/client";
import { logger } from "@/shared/utils";
import { ruleMatches } from "@/shared/pipeline/rules.ts";
import { MAX_CONNECTOR_CHAIN_DEPTH } from "@/shared/pipeline/connectors.ts";
import { decideMerge, mergeSourceContexts } from "@/shared/pipeline/merges.ts";
import { startExecution } from "@/shared/pipeline/startExecution.ts";

export interface MergeEvaluatorDeps {
  prisma: PrismaClient;
}

type EndedStatus = Exclude<MergeRunStatus, typeof MergeRunStatus.WAITING>;

// ============================================================
// Merge evaluator
// Handles merge messages on pipeline.connectors: after each arrival and at the deadline.
// Decides once every source is in (or one failed, or time ran out) and, when the rule is met,
// starts the target in the same transaction that records the decision.
// ============================================================

export class MergeEvaluator {
  constructor(private deps: MergeEvaluatorDeps) {}

  async handle(mergeRunId: string, now: Date = new Date()): Promise<void> {
    const { prisma } = this.deps;
    const run = await prisma.mergeRun.findUnique({
      where: { id: mergeRunId },
      include: {
        merge: {
          include: { sources: { include: { pipeline: { select: { name: true } } } } },
        },
        arrivals: {
          include: { execution: { select: { context: true, chainDepth: true } } },
        },
        workflowRun: { select: { id: true, workflowId: true } },
      },
    });

    if (!run) {
      logger.warn(`[merge-evaluator] Merge run not found, skipping: ${mergeRunId}`);
      return;
    }
    // Already decided: a later arrival or the deadline message has nothing left to do
    if (run.status !== MergeRunStatus.WAITING) return;

    const { merge } = run;
    if (!merge.isActive) {
      await this.end(prisma, run.id, MergeRunStatus.CANCELLED, "Connector was deactivated");
      return;
    }

    const decision = decideMerge({
      triggerRule: merge.triggerRule,
      sources: merge.sources.map((s) => ({ pipelineId: s.pipelineId, name: s.pipeline.name })),
      arrivals: run.arrivals,
      deadlineAt: run.deadlineAt,
      now,
    });
    if (decision.kind === "wait") return;
    if (decision.kind === "fail") {
      await this.end(prisma, run.id, MergeRunStatus.FAILED, decision.reason);
      return;
    }
    if (decision.kind === "time_out") {
      await this.end(prisma, run.id, MergeRunStatus.TIMED_OUT, decision.reason);
      return;
    }

    let matched: boolean;
    try {
      matched = ruleMatches(merge.condition, {
        context: mergeSourceContexts(run.arrivals.map((a) => a.execution.context)),
        status: decision.status,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.end(
        prisma,
        run.id,
        MergeRunStatus.FAILED,
        `Rule could not be evaluated: ${message}`
      );
      return;
    }
    if (!matched) {
      await this.end(prisma, run.id, MergeRunStatus.NOT_MET, "Rule not met");
      return;
    }

    const chainDepth = Math.max(...run.arrivals.map((a) => a.execution.chainDepth)) + 1;
    if (chainDepth > MAX_CONNECTOR_CHAIN_DEPTH) {
      await this.end(
        prisma,
        run.id,
        MergeRunStatus.FAILED,
        `Chain of connectors is longer than ${MAX_CONNECTOR_CHAIN_DEPTH}; not starting the target pipeline`
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Claim the run; a concurrent evaluator blocks on this row and then finds it taken
      const claimed = await tx.mergeRun.updateMany({
        where: { id: run.id, status: MergeRunStatus.WAITING },
        data: { status: MergeRunStatus.FIRED, evaluatedAt: now },
      });
      if (claimed.count === 0) return;

      const result = await startExecution(tx, merge.targetPipelineId, {
        triggeredBy: "merge",
        chainDepth,
        workflowRun: run.workflowRun,
      });
      if (result.skipped) {
        await tx.mergeRun.update({
          where: { id: run.id },
          data: {
            status: MergeRunStatus.SKIPPED,
            reason: `Target pipeline did not start: ${result.skipReason ?? "skipped"}`,
          },
        });
        return;
      }

      await tx.mergeRun.update({
        where: { id: run.id },
        data: { targetExecutionId: result.executionId },
      });
      await tx.executionLog.create({
        data: {
          executionId: result.executionId,
          level: LogLevel.INFO,
          message: `Started by connector "${merge.name}" once ${merge.sources
            .map((s) => s.pipeline.name)
            .join(", ")} finished`,
          metadata: { mergeId: merge.id, mergeRunId: run.id },
        },
      });
      logger.info(
        `[merge-evaluator] Merge fired mergeRunId=${run.id} targetExecutionId=${result.executionId}`
      );
    });
  }

  private async end(
    prisma: PrismaClient,
    mergeRunId: string,
    status: EndedStatus,
    reason: string
  ): Promise<void> {
    await prisma.mergeRun.updateMany({
      where: { id: mergeRunId, status: MergeRunStatus.WAITING },
      data: { status, reason, evaluatedAt: new Date() },
    });
    logger.info(
      `[merge-evaluator] Merge run ended mergeRunId=${mergeRunId} status=${status} reason="${reason}"`
    );
  }
}
