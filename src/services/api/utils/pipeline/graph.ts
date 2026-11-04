import type { PrismaClient } from "@db/client";
import { findConnectorCycle, type ConnectorEdge } from "@/shared/pipeline/connectors.ts";

/**
 * Every "this pipeline can start that one" edge from active connectors (target and otherwise)
 * and active merges (each source to the target), leaving out the one being edited.
 */
export async function activePipelineEdges(
  db: PrismaClient,
  exclude: { connectorId?: string; mergeId?: string } = {}
): Promise<ConnectorEdge[]> {
  const [connectors, merges] = await Promise.all([
    db.pipelineConnector.findMany({
      where: {
        isActive: true,
        ...(exclude.connectorId ? { id: { not: exclude.connectorId } } : {}),
      },
      select: { sourcePipelineId: true, targetPipelineId: true, otherwisePipelineId: true },
    }),
    db.pipelineMerge.findMany({
      where: { isActive: true, ...(exclude.mergeId ? { id: { not: exclude.mergeId } } : {}) },
      select: { targetPipelineId: true, sources: { select: { pipelineId: true } } },
    }),
  ]);
  return [
    ...connectors.flatMap((c) =>
      [c.targetPipelineId, c.otherwisePipelineId]
        .filter((target): target is string => Boolean(target))
        .map((targetPipelineId) => ({ sourcePipelineId: c.sourcePipelineId, targetPipelineId }))
    ),
    ...merges.flatMap((m) =>
      m.sources.map((s) => ({
        sourcePipelineId: s.pipelineId,
        targetPipelineId: m.targetPipelineId,
      }))
    ),
  ];
}

/** The loop the new edges would close, as pipeline ids and a readable "A → B → A", or null. */
export async function findPipelineLoop(
  db: PrismaClient,
  edges: ConnectorEdge[],
  exclude: { connectorId?: string; mergeId?: string } = {}
): Promise<{ pipelineIds: string[]; path: string } | null> {
  const existing = await activePipelineEdges(db, exclude);
  let cycle: string[] | null = null;
  for (const edge of edges) {
    cycle = findConnectorCycle(existing, edge);
    if (cycle) break;
    existing.push(edge);
  }
  if (!cycle) return null;

  const pipelines = await db.pipeline.findMany({
    where: { id: { in: cycle } },
    select: { id: true, name: true },
  });
  const names = new Map(pipelines.map((p) => [p.id, p.name]));
  return { pipelineIds: cycle, path: cycle.map((id) => names.get(id) ?? id).join(" → ") };
}
