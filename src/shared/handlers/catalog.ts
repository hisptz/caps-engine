import { HANDLERS, type Handlers } from "@/services/worker/constants/handlers.ts";
import type { ZodObject } from "zod";
import { z } from "zod";

/** JSON Schema object returned on GET /handlers (draft-2020-12). */
export type HandlerJsonSchema = Record<string, unknown>;

export type HandlerDescriptor = {
  key: string;
  displayName: string;
  description: string;
  tags: string[];
  queueName: string;
  schemas?: {
    config?: HandlerJsonSchema;
    context?: HandlerJsonSchema;
  };
};

const JSON_SCHEMA_TARGET = "draft-2020-12" as const;

function zodToJsonSchema(schema: ZodObject): HandlerJsonSchema {
  return z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET }) as HandlerJsonSchema;
}

function getRegistryConfigSchema(key: string): ZodObject | undefined {
  const entry = HANDLERS.get(key as Handlers);
  return entry?.schemas.config;
}

function getRegistryContextSchema(key: string): ZodObject | undefined {
  const entry = HANDLERS.get(key as Handlers);
  return entry?.schemas.context;
}

export function hasHandlerContextSchema(handlerKey: string): boolean {
  return getRegistryContextSchema(handlerKey) !== undefined;
}

export function listHandlerDescriptors(): HandlerDescriptor[] {
  const descriptors: HandlerDescriptor[] = [];
  for (const [key, entry] of HANDLERS) {
    const schemas: HandlerDescriptor["schemas"] = {};
    if (entry.schemas.config) {
      schemas.config = zodToJsonSchema(entry.schemas.config);
    }
    if (entry.schemas.context) {
      schemas.context = zodToJsonSchema(entry.schemas.context);
    }
    descriptors.push({
      key,
      displayName: entry.displayName,
      description: entry.description,
      tags: entry.tags,
      queueName: entry.queueName,
      ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
    });
  }
  return descriptors;
}

export function getHandlerDescriptor(key: string): HandlerDescriptor | undefined {
  return listHandlerDescriptors().find((d) => d.key === key);
}

export function isKnownHandlerKey(key: string): key is Handlers {
  return HANDLERS.has(key as Handlers);
}

export function getHandlerQueueName(key: string): string | undefined {
  const entry = HANDLERS.get(key as Handlers);
  return entry?.queueName;
}

/** Resolves the RabbitMQ queue for a pipeline step from its handler key. */
export function resolveStepQueueName(handlerKey: string): string | undefined {
  return getHandlerQueueName(handlerKey);
}

export type HandlerConfigValidationResult =
  | { success: true }
  | { success: false; issues: z.core.$ZodIssue[] };

export function validateHandlerConfig(
  handlerKey: string,
  handlerConfig: unknown
): HandlerConfigValidationResult {
  const configSchema = getRegistryConfigSchema(handlerKey);
  if (!configSchema) {
    return { success: true };
  }
  if (handlerConfig === undefined || handlerConfig === null) {
    return {
      success: false,
      issues: [
        {
          code: "custom",
          message: "handlerConfig is required for this handler",
          path: [],
        } as z.core.$ZodIssue,
      ],
    };
  }
  const result = configSchema.safeParse(handlerConfig);
  if (result.success) {
    return { success: true };
  }
  return { success: false, issues: result.error.issues };
}

export function formatHandlerConfigIssues(issues: z.core.$ZodIssue[]): {
  error: string;
  details: Array<{ path: string; message: string }>;
} {
  return {
    error: "Invalid handler configuration",
    details: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export type HandlerContextValidationResult =
  | { success: true }
  | { success: false; issues: z.core.$ZodIssue[] };

export function validateHandlerContext(
  handlerKey: string,
  contextOverride: unknown
): HandlerContextValidationResult {
  const contextSchema = getRegistryContextSchema(handlerKey);
  if (!contextSchema) {
    return { success: true };
  }
  if (contextOverride === undefined || contextOverride === null) {
    return { success: true };
  }
  const result = contextSchema.safeParse(contextOverride);
  if (result.success) {
    return { success: true };
  }
  return { success: false, issues: result.error.issues };
}

export function formatHandlerContextIssues(issues: z.core.$ZodIssue[]): {
  error: string;
  details: Array<{ path: string; message: string }>;
} {
  return {
    error: "Invalid handler context",
    details: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}
