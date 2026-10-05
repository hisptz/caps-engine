import axios, { AxiosError, type AxiosInstance } from "axios";
import { env } from "@/shared/utils/env.ts";

export const dhis2RestClient = axios.create({
  baseURL: `${env.DHIS2_BASE_URL}/api`,
  headers: {
    "Content-Type": "application/json",
  },
  auth: {
    username: env.DHIS2_USERNAME,
    password: env.DHIS2_PASSWORD,
  },
});

/**
 * Client for a DHIS2 route on staging. Requests go to
 * `${DHIS2_BASE_URL}/api/routes/{code}/run/<path>`; staging adds the route's stored
 * credentials and forwards them to the source instance, so paths are the source's API paths
 * (e.g. `system/info`, `analytics/dataValueSet.json`).
 */
export function createRouteClient(routeCode: string): AxiosInstance {
  return axios.create({
    baseURL: `${env.DHIS2_BASE_URL}/api/routes/${encodeURIComponent(routeCode)}/run`,
    headers: {
      "Content-Type": "application/json",
    },
    auth: {
      username: env.DHIS2_USERNAME,
      password: env.DHIS2_PASSWORD,
    },
  });
}

export function describeRouteError(error: unknown, routeCode: string): string {
  if (!(error instanceof AxiosError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const status = error.response?.status;
  switch (status) {
    case undefined:
      return `Could not reach staging DHIS2 to run route "${routeCode}": ${error.message}`;
    case 401:
    case 403:
      return `Route "${routeCode}" refused the request (HTTP ${status}). Either the CAPS user lacks the route's authorities on staging, or the source instance rejected the route's credentials.`;
    case 404:
      return `Route "${routeCode}" or the requested source API path was not found (HTTP 404). Check that the route exists on staging and that its URL ends with /api/**.`;
    case 502:
    case 503:
    case 504:
      return `Route "${routeCode}" could not get an answer from the source instance (HTTP ${status}). It may be down, or the request took longer than the route timeout.`;
    default: {
      const data = error.response?.data as { message?: unknown } | undefined;
      const detail = typeof data?.message === "string" ? `: ${data.message}` : "";
      return `Route "${routeCode}" call failed with HTTP ${status}${detail}`;
    }
  }
}
