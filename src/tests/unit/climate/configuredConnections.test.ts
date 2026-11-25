import { describe, it, expect } from "vitest";
import { configuredConnections } from "@/services/api/modules/climate/pipelinesService.ts";

describe("configuredConnections", () => {
  it("reads GEOSERVICE_DHIS2_CONNECTIONS", () => {
    expect(
      configuredConnections({
        GEOSERVICE_DHIS2_CONNECTIONS: ", staging ,",
      })
    ).toEqual(["", "staging"]);
  });
});
