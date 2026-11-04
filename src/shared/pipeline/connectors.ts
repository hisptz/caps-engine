import { resolvePath } from "@/shared/pipeline/rules.ts";

/** Longest chain of connectors allowed to start executions (A → B → C … counts each hop). */
export const MAX_CONNECTOR_CHAIN_DEPTH = 10;

/**
 * Target context path -> dot path into the source execution's context. Target paths nest, so
 * "steps.<stepId>.orgUnits" lands where that step's handler reads its context override.
 */
export type ConnectorInputMapping = Record<string, string>;

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Explains why a target context path cannot be written, or returns null when it can. */
export function validateTargetPath(path: string): string | null {
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) {
    return `"${path}" has an empty segment`;
  }
  const forbidden = segments.find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
  if (forbidden) {
    return `"${path}" uses the reserved name "${forbidden}"`;
  }
  return null;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

/**
 * Build the target execution's context from the source execution's context.
 * Paths that resolve to nothing are left out rather than passed as undefined.
 */
export function resolveInputMapping(
  mapping: ConnectorInputMapping,
  sourceContext: Record<string, unknown>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [targetPath, sourcePath] of Object.entries(mapping)) {
    if (validateTargetPath(targetPath)) continue;
    const value = resolvePath(sourceContext, sourcePath);
    if (value !== undefined) {
      setPath(input, targetPath, value);
    }
  }
  return input;
}

export type ConnectorEdge = { sourcePipelineId: string; targetPipelineId: string };

/**
 * If adding `edge` to `existing` creates a loop, return the pipeline ids along it
 * (starting and ending at the edge's source); otherwise null.
 */
export function findConnectorCycle(
  existing: ConnectorEdge[],
  edge: ConnectorEdge
): string[] | null {
  if (edge.sourcePipelineId === edge.targetPipelineId) {
    return [edge.sourcePipelineId, edge.targetPipelineId];
  }

  const next = new Map<string, string[]>();
  for (const { sourcePipelineId, targetPipelineId } of existing) {
    next.set(sourcePipelineId, [...(next.get(sourcePipelineId) ?? []), targetPipelineId]);
  }

  // Depth-first search from the new edge's target back to its source
  const visited = new Set<string>();
  const walk = (pipelineId: string, path: string[]): string[] | null => {
    if (pipelineId === edge.sourcePipelineId) return path;
    if (visited.has(pipelineId)) return null;
    visited.add(pipelineId);
    for (const target of next.get(pipelineId) ?? []) {
      const found = walk(target, [...path, target]);
      if (found) return found;
    }
    return null;
  };

  return walk(edge.targetPipelineId, [edge.sourcePipelineId, edge.targetPipelineId]);
}
