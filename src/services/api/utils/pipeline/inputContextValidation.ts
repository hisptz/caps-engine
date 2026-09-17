import type { PipelineStep } from "@db/client";
import { hasHandlerContextSchema, validateHandlerContext } from "@/shared/handlers/catalog.ts";
import { PipelineQueries } from "@/services/api/utils/pipeline/queries.ts";
import { badRequest, notFound, type ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStepsMap(
  inputContext: Record<string, unknown> | undefined
): Record<string, Record<string, unknown>> | undefined {
  if (inputContext === undefined) {
    return undefined;
  }
  const steps = inputContext.steps;
  if (steps === undefined) {
    return undefined;
  }
  if (!isRecord(steps)) {
    return undefined;
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [stepId, slice] of Object.entries(steps)) {
    if (!isRecord(slice)) {
      return undefined;
    }
    result[stepId] = slice;
  }
  return result;
}

/**
 * Validates trigger/schedule input context against pipeline steps and handler context schemas.
 * Returns an ApiError on failure, or undefined when valid.
 */
export async function validatePipelineInputContext(
  queries: PipelineQueries,
  pipelineId: string,
  inputContext: Record<string, unknown> | undefined
): Promise<ApiError | undefined> {
  const stepsMap = extractStepsMap(inputContext);
  if (inputContext !== undefined && inputContext.steps !== undefined && stepsMap === undefined) {
    return badRequest("Invalid input context", ApiErrorCode.VALIDATION_ERROR, [
      { path: "steps", message: "steps must be an object keyed by step id" },
    ]);
  }

  if (!stepsMap || Object.keys(stepsMap).length === 0) {
    return undefined;
  }

  let steps: PipelineStep[];
  try {
    steps = await queries.listSteps(pipelineId);
  } catch {
    return notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
  }

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const allIssues: Array<{ path: string; message: string }> = [];

  for (const [stepId, slice] of Object.entries(stepsMap)) {
    const step = stepById.get(stepId);
    if (!step) {
      allIssues.push({
        path: `steps.${stepId}`,
        message: "Unknown step id for this pipeline",
      });
      continue;
    }
    if (!hasHandlerContextSchema(step.handlerKey)) {
      allIssues.push({
        path: `steps.${stepId}`,
        message: `Handler "${step.handlerKey}" does not accept runtime context`,
      });
      continue;
    }
    const result = validateHandlerContext(step.handlerKey, slice);
    if (!result.success) {
      for (const issue of result.issues) {
        const subPath = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
        allIssues.push({
          path: `steps.${stepId}${subPath}`,
          message: issue.message,
        });
      }
    }
  }

  if (allIssues.length > 0) {
    return badRequest("Invalid input context", ApiErrorCode.VALIDATION_ERROR, allIssues);
  }

  return undefined;
}
