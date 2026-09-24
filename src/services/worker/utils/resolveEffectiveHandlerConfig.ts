import { merge } from "lodash-es";
import {
  formatHandlerConfigIssues,
  formatHandlerContextIssues,
  getHandlerContextReplaceKeys,
  validateHandlerConfig,
  validateHandlerContext,
} from "@/shared/handlers/catalog.ts";

export function extractStepContextOverride(
  pipelineContext: Record<string, unknown>,
  stepId: string
): Record<string, unknown> | undefined {
  const steps = pipelineContext.steps;
  if (steps === null || typeof steps !== "object" || Array.isArray(steps)) {
    return undefined;
  }
  const slice = (steps as Record<string, unknown>)[stepId];
  if (slice === null || typeof slice !== "object" || Array.isArray(slice)) {
    return undefined;
  }
  return slice as Record<string, unknown>;
}

export class EffectiveHandlerConfigError extends Error {
  constructor(
    message: string,
    readonly details?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = "EffectiveHandlerConfigError";
  }
}

/**
 * Merges pipeline execution context step overrides onto static handlerConfig.
 * Context wins on conflicts (deep merge), except for the handler's `contextReplaces` keys,
 * which the context replaces whole. Validates override and merged config.
 */
export function resolveEffectiveHandlerConfig(args: {
  handlerKey: string;
  handlerConfig: Record<string, unknown> | null;
  pipelineContext: Record<string, unknown>;
  stepId: string;
}): Record<string, unknown> {
  const base = args.handlerConfig ?? {};
  const override = extractStepContextOverride(args.pipelineContext, args.stepId);

  if (override !== undefined && Object.keys(override).length > 0) {
    const contextResult = validateHandlerContext(args.handlerKey, override);
    if (!contextResult.success) {
      const formatted = formatHandlerContextIssues(contextResult.issues);
      throw new EffectiveHandlerConfigError(formatted.error, formatted.details);
    }
  }

  let merged = base;
  if (override !== undefined && Object.keys(override).length > 0) {
    merged = merge({}, base, override);
    for (const key of getHandlerContextReplaceKeys(args.handlerKey)) {
      if (key in override) {
        merged[key] = override[key];
      }
    }
  }

  const configResult = validateHandlerConfig(args.handlerKey, merged);
  if (!configResult.success) {
    const formatted = formatHandlerConfigIssues(configResult.issues);
    throw new EffectiveHandlerConfigError(formatted.error, formatted.details);
  }

  return merged;
}
