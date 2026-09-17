import { getSystemInfo as fetchSystemInfo } from "@/services/api/utils/system/info.ts";
import { logger } from "@/shared/utils";
import { internal } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";

export async function getSystemInfo(): ReturnType<typeof fetchSystemInfo> {
  try {
    logger.info("Getting system info");
    const systemInfo = await fetchSystemInfo();
    logger.info("System info retrieved successfully");
    return systemInfo;
  } catch (error) {
    logger.error("Failed to get system info", error);
    const message = error instanceof Error ? error.message : "An unknown error occurred";
    throw internal(message, ApiErrorCode.SYSTEM_INFO_UNAVAILABLE);
  }
}
