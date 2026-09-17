import { z } from "zod";
import { PipelineExecutionStatus } from "@db/client";

export const idParams = z.object({ id: z.uuid() });
export const executionDetailParams = z.object({
  id: z.uuid("Execution ID must be a valid UUID"),
});
export const stepAttemptsParams = z.object({
  id: z.uuid("Execution ID must be a valid uuid"),
  stepId: z.uuid("Step ID must be a valid CUID"),
});
export const stepExecutionIdParams = z.object({
  id: z.string().uuid("Step execution ID must be a valid UUID"),
});
export const taskExecutionIdParams = z.object({
  id: z.string().uuid("Task execution ID must be a valid UUID"),
});

export const listExecutionsQuery = z.object({
  pipelineId: z.uuid().optional(),
  status: z.enum(PipelineExecutionStatus).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export const listDeadLettersQuery = z.object({
  pipelineId: z.uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export const replayDeadLetterBody = z.object({
  targetQueue: z.string().min(1),
  messageBody: z.record(z.string(), z.unknown()),
  executionId: z.uuid().optional(),
});

export const triggerPipelineBody = z.object({
  context: z.record(z.string(), z.unknown()).optional(),
});

export const retryStepExecutionBody = z.object({
  idempotencyKey: z
    .string()
    .min(8, "idempotencyKey must be at least 8 characters")
    .max(128, "idempotencyKey must be at most 128 characters"),
});

export const durationsQuery = z.object({
  days: z.coerce.number().min(1).max(90).default(7),
});

export const topErrorsQuery = z.object({
  days: z.coerce.number().min(1).max(90).default(7),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export const topFailingStepsQuery = z.object({
  days: z.coerce.number().min(1).max(90).default(7),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export const trendsQuery = z.object({
  days: z.coerce.number().min(1).max(365).default(30),
  pipelineId: z.uuid().optional(),
});

export type ListExecutionsQuery = z.infer<typeof listExecutionsQuery>;
export type ListDeadLettersQuery = z.infer<typeof listDeadLettersQuery>;
export type ReplayDeadLetterBody = z.infer<typeof replayDeadLetterBody>;
export type TriggerPipelineBody = z.infer<typeof triggerPipelineBody>;
export type RetryStepExecutionBody = z.infer<typeof retryStepExecutionBody>;
