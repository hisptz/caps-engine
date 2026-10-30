import { ConnectorRunStatus, LogLevel, type PrismaClient } from "@db/client";
import { logger } from "@/shared/utils";
import { ruleMatches } from "@/shared/pipeline/rules.ts";
import {
  MAX_CONNECTOR_CHAIN_DEPTH,
  resolveInputMapping,
  type ConnectorInputMapping,
} from "@/shared/pipeline/connectors.ts";
import { startExecution } from "@/shared/pipeline/startExecution.ts";
import type { OutboxTx } from "@/shared/pipeline/outbox.ts";

export interface ConnectorEvaluatorDeps {
  prisma: PrismaClient;
}

type EndedStatus = Exclude<ConnectorRunStatus, typeof ConnectorRunStatus.WAITING>;

// ============================================================
// Connector evaluator
// Consumes pipeline.connectors: one message per connector run, delivered once its
// delay is up. Decides whether the connector fires, and if so starts the target
// pipeline in the same transaction that records the decision.
// ============================================================

export class ConnectorEvaluator {
  constructor(private deps: ConnectorEvaluatorDeps) {}

  async handle(connectorRunId: string): Promise<void> {
    const { prisma } = this.deps;
    const run = await prisma.connectorRun.findUnique({
      where: { id: connectorRunId },
      include: {
        connector: true,
        sourceExecution: { select: { id: true, context: true, chainDepth: true } },
      },
    });

    if (!run) {
      logger.warn(`[connector-evaluator] Connector run not found, skipping: ${connectorRunId}`);
      return;
    }
    // Duplicate delivery, or cancelled meanwhile
    if (run.status !== ConnectorRunStatus.WAITING) {
      logger.info(
        `[connector-evaluator] Connector run already ${run.status.toLowerCase()}, skipping: ${connectorRunId}`
      );
      return;
    }

    const { connector, sourceExecution } = run;
    const sourceContext = (sourceExecution.context ?? {}) as Record<string, unknown>;

    if (!connector.isActive) {
      await this.end(prisma, run, ConnectorRunStatus.CANCELLED, "Connector was deactivated");
      return;
    }

    let matched: boolean;
    try {
      matched = ruleMatches(connector.condition, {
        context: sourceContext,
        status: run.sourceStatus,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.end(
        prisma,
        run,
        ConnectorRunStatus.FAILED,
        `Rule could not be evaluated: ${message}`
      );
      return;
    }
    if (!matched) {
      await this.end(prisma, run, ConnectorRunStatus.NOT_MET, "Rule not met");
      return;
    }

    const chainDepth = sourceExecution.chainDepth + 1;
    if (chainDepth > MAX_CONNECTOR_CHAIN_DEPTH) {
      await this.end(
        prisma,
        run,
        ConnectorRunStatus.FAILED,
        `Chain of connectors is longer than ${MAX_CONNECTOR_CHAIN_DEPTH}; not starting the target pipeline`
      );
      return;
    }

    const input = resolveInputMapping(
      connector.inputMapping as ConnectorInputMapping,
      sourceContext
    );

    await prisma.$transaction(async (tx) => {
      // Claim the run; a concurrent evaluator blocks on this row and then finds it taken
      const claimed = await tx.connectorRun.updateMany({
        where: { id: run.id, status: ConnectorRunStatus.WAITING },
        data: { status: ConnectorRunStatus.FIRED, evaluatedAt: new Date() },
      });
      if (claimed.count === 0) {
        return;
      }

      const result = await startExecution(tx, connector.targetPipelineId, {
        triggeredBy: "connector",
        context: input,
        chainDepth,
      });

      if (result.skipped) {
        const reason = `Target pipeline did not start: ${result.skipReason ?? "skipped"}`;
        await tx.connectorRun.update({
          where: { id: run.id },
          data: { status: ConnectorRunStatus.SKIPPED, reason },
        });
        await this.logOnSource(
          tx,
          run.sourceExecutionId,
          "WARN",
          `Connector "${connector.name}": ${reason}`
        );
        logger.warn(
          `[connector-evaluator] Connector run skipped connectorRunId=${run.id} reason="${reason}"`
        );
        return;
      }

      await tx.connectorRun.update({
        where: { id: run.id },
        data: { targetExecutionId: result.executionId },
      });
      await this.logOnSource(
        tx,
        run.sourceExecutionId,
        "INFO",
        `Connector "${connector.name}" started execution ${result.executionId}`
      );
      await tx.executionLog.create({
        data: {
          executionId: result.executionId,
          level: LogLevel.INFO,
          message: `Started by connector "${connector.name}" from execution ${run.sourceExecutionId}`,
          metadata: { connectorId: connector.id, connectorRunId: run.id },
        },
      });
      logger.info(
        `[connector-evaluator] Connector fired connectorRunId=${run.id} targetExecutionId=${result.executionId}`
      );
    });
  }

  private async end(
    prisma: PrismaClient,
    run: { id: string; sourceExecutionId: string; connector: { name: string } },
    status: EndedStatus,
    reason: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.connectorRun.updateMany({
        where: { id: run.id, status: ConnectorRunStatus.WAITING },
        data: { status, reason, evaluatedAt: new Date() },
      });
      if (updated.count === 0) return;
      await this.logOnSource(
        tx,
        run.sourceExecutionId,
        status === ConnectorRunStatus.FAILED ? "WARN" : "INFO",
        `Connector "${run.connector.name}": ${reason}`
      );
    });
    logger.info(
      `[connector-evaluator] Connector run ended connectorRunId=${run.id} status=${status} reason="${reason}"`
    );
  }

  private async logOnSource(
    tx: OutboxTx,
    executionId: string,
    level: "INFO" | "WARN",
    message: string
  ): Promise<void> {
    await tx.executionLog.create({
      data: { executionId, level: level as LogLevel, message, metadata: {} },
    });
  }
}
