import { version } from "../../../../../package.json";
import type { components as chap } from "~types/chap";
import type { components as dhis } from "~types/dhis";
import type { components as climateApi } from "~types/climateApi";
import { chapClient } from "@/shared/clients/chap.ts";
import { logger } from "@/shared/utils";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { AxiosError } from "axios";
import { climateApiClient } from "@/shared/clients/climateApi.ts";

type ChapSystemInfoResponse = chap["schemas"]["SystemInfoResponse"];
type DHIS2SystemInfoResponse = dhis["schemas"]["Dhis2Info"];
type ClimateSystemInfoResponse = climateApi["schemas"]["AppInfo"];

interface BaseSystemInfoResponse {
  connected: boolean;
}

interface ConnectedSystemInfoResponse<SystemInfoType> extends BaseSystemInfoResponse {
  connected: true;
  info: SystemInfoType;
}

interface DisconnectedSystemInfoResponse extends BaseSystemInfoResponse {
  connected: false;
  error: string;
  stack?: string;
}

type SystemInfoResponse<SystemInfoType> =
  | ConnectedSystemInfoResponse<SystemInfoType>
  | DisconnectedSystemInfoResponse;

function handleError(error: unknown): DisconnectedSystemInfoResponse {
  if (error instanceof AxiosError) {
    return {
      connected: false,
      error: error.message,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      connected: false,
      error: error.message,
    };
  }
  return {
    connected: false,
    error: "Unknown error",
  };
}

export async function getCHAPSystemInfo(): Promise<SystemInfoResponse<ChapSystemInfoResponse>> {
  try {
    const response = await chapClient.get<ChapSystemInfoResponse>(`system/info`);
    if (response.status === 200) {
      return {
        connected: true,
        info: response.data,
      };
    } else {
      return {
        connected: false,
        error: response.statusText,
      };
    }
  } catch (error) {
    logger.info("Failed to fetch CHAP system info", error);
    return handleError(error);
  }
}

export async function getDHIS2SystemInfo(): Promise<SystemInfoResponse<DHIS2SystemInfoResponse>> {
  try {
    const response = await dhis2RestClient.get<DHIS2SystemInfoResponse>(`system/info`);
    return {
      connected: true,
      info: response.data,
    };
  } catch (error) {
    logger.info("Failed to fetch DHIS2 system info", error);
    return handleError(error);
  }
}

export async function getClimateApiSystemInfo(): Promise<
  SystemInfoResponse<ClimateSystemInfoResponse>
> {
  try {
    const response = await climateApiClient.get<ClimateSystemInfoResponse>(`info`);
    return {
      connected: true,
      info: response.data,
    };
  } catch (error) {
    logger.info("Failed to fetch Climate API system info", error);
    return handleError(error);
  }
}

export async function getSystemInfo() {
  const [chapInfo, dhis2Info, climateApiInfo] = await Promise.all([
    getCHAPSystemInfo(),
    getDHIS2SystemInfo(),
    getClimateApiSystemInfo(),
  ]);
  return {
    caps: {
      version,
      chap: chapInfo,
      dhis: dhis2Info,
      climateApi: climateApiInfo,
    },
  };
}
