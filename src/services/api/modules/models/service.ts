import { AxiosError } from "axios";
import { chapClient } from "@/shared/clients/chap.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

export type ModelCovariate = {
  name: string;
  displayName: string;
};

export type ConfiguredModel = {
  id: string;
  name: string;
  displayName: string;
  covariates: ModelCovariate[];
  /** The feature the model predicts (e.g. `disease_cases`). */
  target?: ModelCovariate;
  supportedPeriodType?: string;
};

export type ModelsResponse = {
  models: ConfiguredModel[];
  error?: string;
  code?: string;
};

function mapFeature(value: unknown): ModelCovariate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const displayName =
    typeof record["displayName"] === "string" && record["displayName"].length > 0
      ? record["displayName"]
      : name;
  return { name, displayName };
}

function mapCovariates(value: unknown): ModelCovariate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(mapFeature).filter((feature): feature is ModelCovariate => feature !== null);
}

function mapConfiguredModel(item: unknown): ConfiguredModel | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"].length === 0) {
    return null;
  }
  const id = record["id"];
  if (typeof id !== "string" && typeof id !== "number") {
    return null;
  }
  const displayName =
    typeof record["displayName"] === "string" && record["displayName"].length > 0
      ? record["displayName"]
      : record["name"];
  const supportedPeriodType = record["supportedPeriodType"];
  const target = mapFeature(record["target"]);
  return {
    id: String(id),
    name: record["name"],
    displayName,
    covariates: mapCovariates(record["covariates"]),
    ...(target ? { target } : {}),
    ...(typeof supportedPeriodType === "string" ? { supportedPeriodType } : {}),
  };
}

function mapConfiguredModels(data: unknown): ConfiguredModel[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const models: ConfiguredModel[] = [];
  for (const item of data) {
    const mapped = mapConfiguredModel(item);
    if (mapped) {
      models.push(mapped);
    }
  }
  return models;
}

/** Always resolves with HTTP 200 semantics; `error`/`code` present when CHAP is unreachable. */
export async function getModels(): Promise<ModelsResponse> {
  try {
    const response = await chapClient.get<unknown>("/v1/crud/configured-models");
    return { models: mapConfiguredModels(response.data) };
  } catch (error) {
    const message = error instanceof AxiosError ? error.message : "CHAP is currently unreachable";
    return { models: [], error: message, code: ApiErrorCode.CHAP_UNAVAILABLE };
  }
}
