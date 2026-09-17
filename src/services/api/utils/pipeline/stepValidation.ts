import {
  formatHandlerConfigIssues,
  isKnownHandlerKey,
  validateHandlerConfig,
} from "@/shared/handlers/catalog.ts";
import { badRequest, type ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

export type StepHandlerInput = {
  handlerKey: string;
  handlerConfig?: Record<string, unknown>;
};

export type ValidatedStepHandlerInput = StepHandlerInput;

export function validateStepHandlerInput(
  input: StepHandlerInput,
  options?: { requireHandlerKey?: boolean }
): ApiError | ValidatedStepHandlerInput {
  const requireHandlerKey = options?.requireHandlerKey ?? true;

  if (requireHandlerKey && !isKnownHandlerKey(input.handlerKey)) {
    return badRequest("Unknown handler key", ApiErrorCode.STEP_HANDLER_CONFIG_INVALID, {
      handlerKey: input.handlerKey,
    });
  }

  if (isKnownHandlerKey(input.handlerKey)) {
    const configResult = validateHandlerConfig(input.handlerKey, input.handlerConfig);
    if (!configResult.success) {
      const { error, details } = formatHandlerConfigIssues(configResult.issues);
      return badRequest(error, ApiErrorCode.STEP_HANDLER_CONFIG_INVALID, details);
    }
  }

  return input;
}
