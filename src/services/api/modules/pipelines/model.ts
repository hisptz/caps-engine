import { z } from "zod";
import { ConcurrencyPolicy } from "@db/client";
import { cronExprSchema } from "@/shared/utils/cron.ts";

export const idParams = z.object({ id: z.uuid("Invalid pipeline ID") });
export const stepParams = z.object({
  id: z.uuid("Invalid pipeline ID"),
  stepId: z.uuid("Invalid step ID"),
});

export const listPipelinesQuery = z.object({
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export const createPipelineBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().default(true),
  concurrencyPolicy: z.enum(ConcurrencyPolicy).default(ConcurrencyPolicy.SKIP),
});

export const updatePipelineBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  concurrencyPolicy: z.enum(ConcurrencyPolicy).optional(),
});

export const createStepBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  handlerKey: z.string().min(1),
  stepOrder: z.number().int().min(0),
  maxRetries: z.number().int().min(0).default(3),
  retryDelayMs: z.number().int().min(0).default(1000),
  inputSchema: z.unknown().optional(),
  handlerConfig: z.record(z.string(), z.unknown()).optional(),
});

export const updateStepBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  handlerKey: z.string().min(1).optional(),
  stepOrder: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
  retryDelayMs: z.number().int().min(0).optional(),
  inputSchema: z.unknown().optional(),
  handlerConfig: z.record(z.string(), z.unknown()).optional(),
});

export const createScheduleBody = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    cronExpr: cronExprSchema,
    inputContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ListPipelinesQuery = z.infer<typeof listPipelinesQuery>;
export type CreatePipelineBody = z.infer<typeof createPipelineBody>;
export type UpdatePipelineBody = z.infer<typeof updatePipelineBody>;
export type CreateStepBody = z.infer<typeof createStepBody>;
export type UpdateStepBody = z.infer<typeof updateStepBody>;
export type CreateScheduleBody = z.infer<typeof createScheduleBody>;
