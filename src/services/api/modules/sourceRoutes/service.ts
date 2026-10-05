import { createRouteClient, describeRouteError } from "@/shared/clients/dhis.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { analyticsUpTo, type AnalyticsSystemInfo } from "@/shared/utils/sourceAnalytics.ts";

type SourceMe = { username?: string; displayName?: string };

type SourceSystemInfo = AnalyticsSystemInfo & {
  systemName?: string;
  version?: string;
  revision?: string;
  contextPath?: string;
  serverDate?: string;
};

export type SourceRouteTestResponse = {
  routeCode: string;
  reachable: boolean;
  user?: { username: string | null; displayName: string | null };
  system?: {
    systemName: string | null;
    version: string | null;
    revision: string | null;
    contextPath: string | null;
    serverDate: string | null;
    analyticsUpTo: string | null;
  };
  error?: string;
  code?: string;
};

export async function testSourceRoute(routeCode: string): Promise<SourceRouteTestResponse> {
  const client = createRouteClient(routeCode);
  try {
    const [me, info] = await Promise.all([
      client.get<SourceMe>("me.json", { params: { fields: "username,displayName" } }),
      client.get<SourceSystemInfo>("system/info.json"),
    ]);
    return {
      routeCode,
      reachable: true,
      user: {
        username: me.data.username ?? null,
        displayName: me.data.displayName ?? null,
      },
      system: {
        systemName: info.data.systemName ?? null,
        version: info.data.version ?? null,
        revision: info.data.revision ?? null,
        contextPath: info.data.contextPath ?? null,
        serverDate: info.data.serverDate ?? null,
        analyticsUpTo: analyticsUpTo(info.data),
      },
    };
  } catch (error) {
    return {
      routeCode,
      reachable: false,
      error: describeRouteError(error, routeCode),
      code: ApiErrorCode.SOURCE_ROUTE_UNAVAILABLE,
    };
  }
}
