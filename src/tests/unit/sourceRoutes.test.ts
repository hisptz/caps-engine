import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

const mockRouteGet = vi.fn();

vi.mock("@/shared/clients/dhis.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/clients/dhis.ts")>();
  return {
    describeRouteError: actual.describeRouteError,
    dhis2RestClient: { get: vi.fn() },
    createRouteClient: vi.fn(() => ({ get: mockRouteGet })),
  };
});

import { createRouteClient } from "@/shared/clients/dhis.ts";
import { testSourceRoute } from "@/services/api/modules/sourceRoutes/service.ts";

describe("testSourceRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the source user, version and last analytics run", async () => {
    mockRouteGet.mockImplementation(async (url: string) =>
      url === "me.json"
        ? { data: { username: "caps_reader", displayName: "CAPS Reader" } }
        : {
            data: {
              version: "2.41.2",
              revision: "abc123",
              contextPath: "https://play.im.dhis2.org/dev",
              serverDate: "2026-09-28T09:00:00.000",
              lastAnalyticsTableSuccess: "2026-09-28T02:00:00.000",
            },
          }
    );

    const result = await testSourceRoute("caps-src-play");

    expect(createRouteClient).toHaveBeenCalledWith("caps-src-play");
    expect(result).toEqual({
      routeCode: "caps-src-play",
      reachable: true,
      user: { username: "caps_reader", displayName: "CAPS Reader" },
      system: {
        version: "2.41.2",
        revision: "abc123",
        contextPath: "https://play.im.dhis2.org/dev",
        serverDate: "2026-09-28T09:00:00.000",
        analyticsUpTo: "2026-09-28T02:00:00.000",
      },
    });
  });

  it("reports an unreachable route without throwing", async () => {
    mockRouteGet.mockRejectedValue(new AxiosError("connect ECONNREFUSED"));

    const result = await testSourceRoute("caps-src-play");

    expect(result).toMatchObject({
      routeCode: "caps-src-play",
      reachable: false,
      code: "source_route_unavailable",
    });
    expect(result.error).toMatch(/Could not reach staging DHIS2 to run route "caps-src-play"/);
  });
});
