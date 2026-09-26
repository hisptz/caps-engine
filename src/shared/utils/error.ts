import { AxiosError } from "axios";

export const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 2000;

export interface ErrorConflict {
  value: string;
  count: number;
  objects: string[];
}

export interface ErrorDetails {
  source?: string;
  httpStatus?: number;
  description?: string;
  conflicts?: ErrorConflict[];
  totalConflicts?: number;
  fullMessage?: string;
  [key: string]: unknown;
}

/**
 * Throw from a handler when the failure has structured context worth keeping.
 * Keep `message` short and stable (it is grouped on in the top-errors view); put
 * the variable parts in `details`.
 */
export class StepError extends Error {
  readonly details: ErrorDetails;

  constructor(message: string, details: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = "StepError";
    this.details = details;
  }
}

/** Collapse repeated conflicts by message, keeping counts and a sample of objects. */
export function groupConflicts(
  conflicts: Array<{ object?: string; value: string }>,
  sampleSize = 5
): ErrorConflict[] {
  const groups = new Map<string, ErrorConflict>();
  for (const { object, value } of conflicts) {
    const group = groups.get(value) ?? { value, count: 0, objects: [] };
    group.count += 1;
    if (object && group.objects.length < sampleSize && !group.objects.includes(object)) {
      group.objects.push(object);
    }
    groups.set(value, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeResponseBody(data: unknown): string | undefined {
  if (data == null || data === "") {
    return undefined;
  }
  if (typeof data === "string") {
    return truncate(data, MAX_DESCRIPTION_LENGTH);
  }
  if (typeof data === "object") {
    const body = data as Record<string, unknown>;
    for (const key of ["message", "detail", "description", "error"]) {
      if (typeof body[key] === "string" && body[key]) {
        return truncate(body[key], MAX_DESCRIPTION_LENGTH);
      }
    }
  }
  return truncate(JSON.stringify(data), MAX_DESCRIPTION_LENGTH);
}

function axiosDetails(err: AxiosError): ErrorDetails {
  const method = err.config?.method?.toUpperCase();
  const url = err.config?.url;
  return {
    httpStatus: err.response?.status,
    request: method && url ? `${method} ${url}` : url,
    description: describeResponseBody(err.response?.data),
  };
}

/**
 * Split an error into the columns persisted on StepExecution/TaskExecution:
 * a short headline, the stack, and structured details (if any).
 */
export function toErrorRecord(err: Error): {
  errorMessage: string;
  errorStack: string | undefined;
  errorDetails: ErrorDetails | undefined;
} {
  let details: ErrorDetails | undefined;
  if (err instanceof StepError) {
    details = { ...err.details };
  } else if (err instanceof AxiosError) {
    details = axiosDetails(err);
  }

  const errorMessage = truncate(err.message, MAX_ERROR_MESSAGE_LENGTH);
  if (errorMessage !== err.message) {
    details = { ...details, fullMessage: err.message };
  }

  return { errorMessage, errorStack: err.stack, errorDetails: details };
}
