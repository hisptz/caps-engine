export const ASYNC_PREFER_HEADER = "respond-async";

export type AsyncJobAcceptedResponse = {
  jobId: string;
  status: "accepted";
  ingestion_id?: string;
};

export function extractJobIdFromLocation(location: string | undefined): string | null {
  if (!location) {
    return null;
  }
  const match = location.match(/\/ingestions\/jobs\/([^/]+)/);
  return match?.[1] ?? null;
}

export function buildAsyncPreferHeaders(useAsync: boolean): Record<string, string> {
  if (!useAsync) {
    return {};
  }
  return { Prefer: ASYNC_PREFER_HEADER };
}

export function normalizeAsyncPostResponse(
  status: number,
  data: unknown,
  headers: Record<string, unknown>,
  useAsync: boolean
): Response {
  if (!useAsync) {
    return Response.json(data, { status });
  }

  if (status === 202) {
    const location =
      typeof headers.location === "string"
        ? headers.location
        : typeof headers.Location === "string"
          ? headers.Location
          : undefined;
    const jobId = extractJobIdFromLocation(location);
    if (jobId) {
      const body: AsyncJobAcceptedResponse = {
        jobId,
        status: "accepted",
      };
      if (
        typeof data === "object" &&
        data !== null &&
        "ingestion_id" in data &&
        typeof (data as { ingestion_id: unknown }).ingestion_id === "string"
      ) {
        body.ingestion_id = (data as { ingestion_id: string }).ingestion_id;
      }
      return Response.json(body);
    }
  }

  return Response.json(data, { status });
}
