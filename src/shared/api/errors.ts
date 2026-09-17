import type { Context } from "elysia";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

export type ApiErrorBody = {
  error: string;
  code: string;
  details?: unknown;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown
): ApiError {
  return new ApiError(status, code, message, details);
}

export const notFound = (message: string, code: string, details?: unknown): ApiError =>
  apiError(404, code, message, details);

export const badRequest = (message: string, code: string, details?: unknown): ApiError =>
  apiError(400, code, message, details);

export const conflict = (message: string, code: string, details?: unknown): ApiError =>
  apiError(409, code, message, details);

export const badGateway = (message: string, code: string, details?: unknown): ApiError =>
  apiError(502, code, message, details);

export const unprocessable = (message: string, code: string, details?: unknown): ApiError =>
  apiError(422, code, message, details);

export const internal = (message: string, code: string, details?: unknown): ApiError =>
  apiError(500, code, message, details);

type OnErrorContext = Pick<Context, "set"> & {
  code: string | number;
  error: unknown;
};

/** App-level `.onError()` handler translating any thrown error into `{ error, code, details? }`. */
export function errorHandler({ code, error, set }: OnErrorContext): ApiErrorBody {
  if (error instanceof ApiError) {
    set.status = error.status;
    const body: ApiErrorBody = { error: error.message, code: error.code };
    if (error.details !== undefined) {
      body.details = error.details;
    }
    return body;
  }

  if (code === "VALIDATION") {
    set.status = 400;
    return {
      error: "Validation failed",
      code: ApiErrorCode.VALIDATION_ERROR,
      details: error instanceof Error ? error.message : error,
    };
  }

  if (code === "NOT_FOUND") {
    set.status = 404;
    return { error: "Not Found", code: ApiErrorCode.NOT_FOUND };
  }

  set.status = 500;
  return { error: "Internal Server Error", code: ApiErrorCode.INTERNAL_ERROR };
}
