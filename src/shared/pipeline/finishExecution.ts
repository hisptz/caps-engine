import { ConnectorTriggerOn, PipelineExecutionStatus } from "@db/client";
import { QUEUES } from "@/services/worker/constants/monitor.ts";
import { enqueueOutboxMessage, type OutboxTx } from "@/shared/pipeline/outbox.ts";

export type FinalExecutionStatus =
  | typeof PipelineExecutionStatus.COMPLETED
  | typeof PipelineExecutionStatus.FAILED;

// Shape of a message on pipeline.connectors
export interface ConnectorJobMessage {
  connectorRunId: string;
}

const MINUTE_MS = 60 * 1000;

/**
 * Mark an execution COMPLETED or FAILED and, in the same transaction, create a connector run for
 * every active connector whose trigger matches. Each run is queued through the outbox for when its
 * delay is up. Every path that ends an execution this way must go through here, or connectors miss it.
 *
 * Returns the ids of the connector runs it created.
 */
export async function finishExecution(
  tx: OutboxTx,
  args: { executionId: string; pipelineId: string; status: FinalExecutionStatus }
): Promise<string[]> {
  const now = new Date();

  await tx.pipelineExecution.update({
    where: { id: args.executionId },
    data: { status: args.status, finishedAt: now },
  });

  const on =
    args.status === PipelineExecutionStatus.COMPLETED
      ? ConnectorTriggerOn.COMPLETED
      : ConnectorTriggerOn.FAILED;
  const connectors = await tx.pipelineConnector.findMany({
    where: {
      sourcePipelineId: args.pipelineId,
      isActive: true,
      on: { in: [on, ConnectorTriggerOn.FINISHED] },
    },
    select: { id: true, delayMinutes: true },
  });
  if (connectors.length === 0) {
    return [];
  }

  // skipDuplicates: an execution revived by a retry and finished again does not fire a connector twice
  const runs = await tx.connectorRun.createManyAndReturn({
    data: connectors.map((connector) => ({
      connectorId: connector.id,
      sourceExecutionId: args.executionId,
      sourceStatus: args.status,
      checkAt: new Date(now.getTime() + connector.delayMinutes * MINUTE_MS),
    })),
    skipDuplicates: true,
    select: { id: true, checkAt: true },
  });

  for (const run of runs) {
    await enqueueOutboxMessage(tx, {
      destination: QUEUES.PIPELINE_CONNECTORS,
      availableAt: run.checkAt,
      payload: { connectorRunId: run.id } satisfies ConnectorJobMessage,
    });
  }

  return runs.map((run) => run.id);
}
