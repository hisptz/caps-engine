import type {
  JobDescription,
  JobResponse,
  MakePredictionRequest,
  PredictionResultData,
} from "@/services/worker/types/chap.ts";
import axios from "axios";
import { chapClient } from "@/shared/clients/chap.ts";

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

/**
 * GET /v1/analytics/prediction-entry/{resultId}
 * Returns forecast rows for the requested quantiles (query matches CHAP OpenAPI).
 */
export async function getPredictionResult({
  resultId,
}: {
  resultId: string;
}): Promise<PredictionResultData[]> {
  const params = new URLSearchParams();
  params.append("quantiles", "0.1");
  params.append("quantiles", "0.25");
  params.append("quantiles", "0.5");
  params.append("quantiles", "0.75");
  params.append("quantiles", "0.9");

  const response = await chapClient.get<PredictionResultData[]>(
    `v1/analytics/prediction-entry/${resultId}`,
    { params }
  );
  return response.data;
}
