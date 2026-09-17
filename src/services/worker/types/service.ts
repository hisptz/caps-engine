// ============================================================
// Handler context — everything a handler receives at runtime
// ============================================================

import type { PipelineStep, StepExecution, TaskExecution } from "@db/client.ts";

export interface TaskReporter {
  /**
   * Start a named task within this step. Returns a reporter scoped
   * to that task for logging and completion tracking.
   */
  startTask(name: string, input?: unknown): Promise<TaskHandle>;
}

export interface TaskHandle {
  taskExecution: TaskExecution;

  /** Write a log entry scoped to this task */
  log(
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** Mark the task as succeeded with an optional output */
  succeed(output?: unknown): Promise<void>;

  /** Mark the task as failed with an error */
  fail(error: Error): Promise<void>;
}

export interface StepContext {
  /** The step definition from the database */
  step: PipelineStep;

  /** The step execution record (this attempt) */
  stepExecution: StepExecution;

  /** Shared pipeline context — output from previous steps */
  pipelineContext: Record<string, unknown>;

  /** Input passed to this step (output of the previous step) */
  input: unknown;

  /** Static config defined on the step definition */
  handlerConfig: Record<string, unknown>;

  /** Write a log entry scoped to this step execution */
  log(
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** Task reporter for tracking sub-tasks within this step */
  tasks: TaskReporter;
}

// ============================================================
// Handler interface — every step handler implements this
// ============================================================

export interface StepHandler {
  /**
   * Execute the step. Return a value to be stored as output
   * and passed as input to the next step.
   *
   * Throw an Error to signal failure. The runner will handle
   * retry scheduling based on the step's configuration.
   *
   * Throw StepSkippedError to mark the step as SKIPPED while
   * allowing the pipeline to continue.
   */
  execute(ctx: StepContext): Promise<unknown>;
}

/**
 * Signals that a step had nothing to do. The step execution is marked
 * SKIPPED and the pipeline advances without treating this as a failure.
 */
export class StepSkippedError extends Error {
  readonly output?: unknown;

  constructor(message: string, output?: unknown) {
    super(message);
    this.name = "StepSkippedError";
    this.output = output;
  }
}

export function isStepSkippedError(error: unknown): error is StepSkippedError {
  return error instanceof StepSkippedError;
}

// ============================================================
// Handler registry — maps handlerKey strings to implementations
// ============================================================

const registry = new Map<string, StepHandler>();

export function registerHandler(key: string, handler: StepHandler): void {
  if (registry.has(key)) {
    throw new Error(`Handler already registered for key: ${key}`);
  }
  registry.set(key, handler);
}

export function resolveHandler(key: string): StepHandler {
  const handler = registry.get(key);
  if (!handler) {
    throw new Error(
      `No handler registered for key: "${key}". ` +
        `Registered keys: ${[...registry.keys()].join(", ")}`
    );
  }
  return handler;
}
