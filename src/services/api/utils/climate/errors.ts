import axios from "axios";
import { apiError, type ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

export function climateApiUnavailableError(): ApiError {
  return apiError(
    502,
    ApiErrorCode.CLIMATE_API_UNAVAILABLE,
    "The climate API service is not reachable. Check CLIMATE_API_BASE_URL."
  );
}

export function climateResourceNotFoundError(details?: unknown): ApiError {
  return apiError(
    404,
    ApiErrorCode.CLIMATE_RESOURCE_NOT_FOUND,
    "The requested climate API resource was not found.",
    details
  );
}

export function datasetNotFoundError(datasetId: string): ApiError {
  return apiError(
    404,
    ApiErrorCode.DATASET_NOT_FOUND,
    `Dataset '${datasetId}' was not found in the climate API service.`,
    { datasetId }
  );
}

export function mapClimateAxiosError(err: unknown, notFoundDetails?: unknown): ApiError | null {
  if (!axios.isAxiosError(err)) {
    return null;
  }
  if (err.response?.status === 404) {
    return climateResourceNotFoundError(notFoundDetails);
  }
  if (err.response?.status === 422) {
    return apiError(
      422,
      ApiErrorCode.CLIMATE_VALIDATION_ERROR,
      "The climate API rejected the request due to validation errors.",
      err.response.data
    );
  }
  return climateApiUnavailableError();
}

export async function handleClimateRequest<T>(
  fn: () => Promise<T>,
  options?: { notFoundDetails?: unknown; mapResult?: (value: T) => T }
): Promise<T> {
  try {
    const result = await fn();
    return options?.mapResult?.(result) ?? result;
  } catch (err) {
    const mapped = mapClimateAxiosError(err, options?.notFoundDetails);
    if (mapped) {
      throw mapped;
    }
    throw err;
  }
}
