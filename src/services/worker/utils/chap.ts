import type {
  JobDescription,
  JobResponse,
  MakePredictionRequest,
  PredictionResultData,
  PredictionSetupRead,
  RunPredictionSetupRequest,
} from "@/services/worker/types/chap.ts";
import axios from "axios";
import { chapClient } from "@/shared/clients/chap.ts";

/**
 * GET /v1/crud/prediction-setups/{id}
 * Returns the setup a prediction step runs: model, org units, covariate sources,
 * period type and quantile targets, all copied from the evaluated backtest.
 */
export async function getPredictionSetup(predictionSetupId: number): Promise<PredictionSetupRead> {
  try {
    const response = await chapClient.get<PredictionSetupRead>(
      `v1/crud/prediction-setups/${predictionSetupId}`
    );
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw new Error(
        `Prediction setup ${predictionSetupId} no longer exists in CHAP. Pick another evaluation for this step.`,
        { cause: err }
      );
    }
    throw err;
  }
}

const RUN_ERROR_HINTS: Record<number, string> = {
  400: "The evaluation behind this setup was scored with a weather provider that cannot forecast (e.g. `observed`). Re-evaluate with a forecasting provider such as `climatology`.",
  404: "The prediction setup no longer exists in CHAP.",
  409: "The configured model for this setup has been archived in CHAP.",
  422: "CHAP rejected the request body; no observations were found for the configured org units and period window.",
};

/**
 * POST /v1/crud/prediction-setups/{id}/run
 * Runs a stored setup against freshly fetched observations and returns the job ID.
 * CHAP rejects unknown fields with 422, so the body carries nothing beyond the request type.
 */
export async function runPredictionSetup(
  predictionSetupId: number,
  request: RunPredictionSetupRequest
): Promise<JobResponse> {
  try {
    const response = await chapClient.post<JobResponse>(
      `v1/crud/prediction-setups/${predictionSetupId}/run`,
      request
    );
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const detail = JSON.stringify(err.response.data);
      const hint = RUN_ERROR_HINTS[status] ?? "";
      throw new Error(
        `CHAP rejected prediction setup run (${status}): ${detail}${hint ? ` — ${hint}` : ""}`,
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * POST /analytics/make-prediction
 * Submits a prediction job and returns the job ID.
 */
export async function triggerPrediction(request: MakePredictionRequest): Promise<JobResponse> {
  try {
    const response = await chapClient.post<JobResponse>("v1/analytics/make-prediction", request);
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(
        `CHAP rejected prediction request (${err.response.status}): ${JSON.stringify(err.response.data)}`,
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * GET /jobs/{job_id}
 * Returns the current status string of a job.
 */
export async function getJobStatus(jobId: string): Promise<string> {
  const response = await chapClient.get<string>(`v1/jobs/${jobId}`);
  return response.data;
}

/**
 * GET /jobs/{job_id} (full description via list endpoint filtered by ID)
 * Returns the full job description.
 */
export async function getJobDescription(jobId: string): Promise<JobDescription | null> {
  const response = await chapClient.get<JobDescription[]>("v1/jobs", {
    params: { ids: [jobId] },
  });
  return response.data[0] ?? null;
}

const DEFAULT_QUANTILES = ["0.1", "0.25", "0.5", "0.75", "0.9"];

/**
 * GET /v1/analytics/prediction-entry/{resultId}
 * Returns forecast rows for the requested quantiles (query matches CHAP OpenAPI).
 */
export async function getPredictionResult({
  resultId,
  quantiles = DEFAULT_QUANTILES,
}: {
  resultId: string;
  quantiles?: string[];
}): Promise<PredictionResultData[]> {
  const params = new URLSearchParams();
  for (const quantile of quantiles.length > 0 ? quantiles : DEFAULT_QUANTILES) {
    params.append("quantiles", quantile);
  }

  const response = await chapClient.get<PredictionResultData[]>(
    `v1/analytics/prediction-entry/${resultId}`,
    { params }
  );
  return response.data;
}
