import type { PipelineStep } from "@db/client";
import { z } from "zod";

/**
 * Immutable capture of a pipeline step definition at attempt creation time.
 * Manual retries must re-run against this snapshot, not the live PipelineStep row.
 */
export const stepDefinitionSnapshotSchema = z.object({
  id: z.string().min(1),
  pipelineId: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  handlerKey: z.string().min(1),
  stepOrder: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  retryDelayMs: z.number().int().nonnegative(),
  inputSchema: z.unknown().nullable(),
  handlerConfig: z.record(z.string(), z.unknown()).default({}),
});

export type StepDefinitionSnapshot = z.infer<typeof stepDefinitionSnapshotSchema>;

export function snapshotFromPipelineStep(step: PipelineStep): StepDefinitionSnapshot {
  return {
    id: step.id,
    pipelineId: step.pipelineId,
    name: step.name,
    description: step.description,
    handlerKey: step.handlerKey,
    stepOrder: step.stepOrder,
    maxRetries: step.maxRetries,
    retryDelayMs: step.retryDelayMs,
    inputSchema: step.inputSchema ?? null,
    handlerConfig: (step.handlerConfig as Record<string, unknown> | null) ?? {},
  };
}

export function parseStepSnapshot(raw: unknown): StepDefinitionSnapshot | null {
  const parsed = stepDefinitionSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Reconstruct a PipelineStep-shaped object for StepContext / handlers. */
export function pipelineStepFromSnapshot(snapshot: StepDefinitionSnapshot): PipelineStep {
  const now = new Date(0);
  return {
    id: snapshot.id,
    pipelineId: snapshot.pipelineId,
    name: snapshot.name,
    description: snapshot.description,
    handlerKey: snapshot.handlerKey,
    stepOrder: snapshot.stepOrder,
    maxRetries: snapshot.maxRetries,
    retryDelayMs: snapshot.retryDelayMs,
    inputSchema: snapshot.inputSchema as PipelineStep["inputSchema"],
    handlerConfig: snapshot.handlerConfig as PipelineStep["handlerConfig"],
    createdAt: now,
    updatedAt: now,
  };
}
