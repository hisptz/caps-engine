import { AxiosError } from "axios";
import { chapClient } from "@/shared/clients/chap.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import type { components } from "~types/chap";

type BacktestRead = components["schemas"]["BacktestRead"];
type PredictionSetupRead = components["schemas"]["PredictionSetupRead"];

export type Evaluation = {
  id: number;
  name: string;
  modelId: string;
  modelDisplayName: string;
  datasetName: string;
  periodType: string | null;
  created: string | null;
  predictionSetupId: number | null;
};

export type EvaluationsResponse = {
  evaluations: Evaluation[];
  error?: string;
  code?: string;
};

export type PredictionSetupResponse = {
  setup: PredictionSetupRead | null;
  error?: string;
  code?: string;
};

function mapEvaluation(backtest: BacktestRead): Evaluation {
  return {
    id: backtest.id,
    name: backtest.name ?? `Evaluation #${backtest.id}`,
    modelId: backtest.modelId,
    modelDisplayName: backtest.configuredModel?.name || backtest.modelId,
    datasetName: backtest.dataset?.name ?? "",
    periodType: backtest.dataset?.periodType ?? null,
    created: backtest.created ?? null,
    predictionSetupId: backtest.predictionSetupId ?? null,
  };
}

function chapErrorFields(error: unknown) {
  const message = error instanceof AxiosError ? error.message : "CHAP is currently unreachable";
  return { error: message, code: ApiErrorCode.CHAP_UNAVAILABLE };
}

export async function getEvaluations(): Promise<EvaluationsResponse> {
  try {
    const response = await chapClient.get<BacktestRead[]>("/v1/crud/backtests");
    const backtests = Array.isArray(response.data) ? response.data : [];
    return { evaluations: backtests.map(mapEvaluation) };
  } catch (error) {
    return { evaluations: [], ...chapErrorFields(error) };
  }
}

export async function getPredictionSetup(id: number): Promise<PredictionSetupResponse> {
  try {
    const response = await chapClient.get<PredictionSetupRead>(`/v1/crud/prediction-setups/${id}`);
    return { setup: response.data };
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return { setup: null };
    }
    return { setup: null, ...chapErrorFields(error) };
  }
}
