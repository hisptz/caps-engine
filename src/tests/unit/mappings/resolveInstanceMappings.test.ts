import { describe, expect, it, vi } from "vitest";
import { OrgUnitMatch } from "@db/client";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { resolveInstanceMappings } from "@/services/worker/utils/resolveInstanceMappings.ts";

const ROUTE = "caps-src-malawi";

function db(instance: unknown) {
  const findUnique = vi.fn().mockResolvedValue(instance);
  return { db: { connectedInstance: { findUnique } } as never, findUnique };
}

const instance = (mappings: unknown[] = [], orgUnitMatch: OrgUnitMatch = OrgUnitMatch.CODE) => ({
  routeCode: ROUTE,
  orgUnitMatch,
  mappings,
});

const mapping = (
  stagingDataElement: string,
  remoteItem: string,
  direction = "PULL",
  remoteItemType = "DATA_ELEMENT"
) => ({ stagingDataElement, remoteItem, direction, remoteItemType });

describe("resolveInstanceMappings", () => {
  it("leaves other handlers alone", async () => {
    const { db: client, findUnique } = db(null);
    const config = { routeCode: ROUTE };
    expect(await resolveInstanceMappings(client, Handlers.DHIS2_DATA_UPLOAD, config)).toBe(config);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("turns a pull's mapped data elements into items, in the step's order", async () => {
    const { db: client } = db(
      instance([
        mapping("StgDeathsAA", "DeathsAAAAA"),
        mapping("StgRateAAAA", "RateAAAAAAA", "PULL", "INDICATOR"),
      ])
    );
    const resolved = await resolveInstanceMappings(client, Handlers.DHIS2_INSTANCE_PULL, {
      routeCode: ROUTE,
      mapped: ["StgRateAAAA", "StgDeathsAA"],
      orgUnitMatch: "id",
    });
    expect(resolved).toEqual({
      routeCode: ROUTE,
      orgUnitMatch: "code",
      items: [
        { from: "RateAAAAAAA", fromType: "INDICATOR", into: "StgRateAAAA" },
        { from: "DeathsAAAAA", fromType: "DATA_ELEMENT", into: "StgDeathsAA" },
      ],
    });
  });

  it("turns a push's mapped data elements into staging → instance items", async () => {
    const { db: client } = db(instance([mapping("StgCasesAAA", "CasesAAAAAA", "PUSH")]));
    const resolved = await resolveInstanceMappings(client, Handlers.DHIS2_INSTANCE_PUSH, {
      routeCode: ROUTE,
      mapped: ["StgCasesAAA"],
    });
    expect(resolved.items).toEqual([{ from: "StgCasesAAA", into: "CasesAAAAAA" }]);
  });

  it("fails the step when a data element is no longer mapped its way", async () => {
    const { db: client } = db(instance([mapping("StgDeathsAA", "DeathsAAAAA", "PUSH")]));
    await expect(
      resolveInstanceMappings(client, Handlers.DHIS2_INSTANCE_PULL, {
        routeCode: ROUTE,
        mapped: ["StgDeathsAA"],
      })
    ).rejects.toMatchObject({
      message: "Some data elements are no longer pulled from this instance",
      details: { dataElements: ["StgDeathsAA"] },
    });
  });

  it("uses the instance's org unit match for older pulls and pushes", async () => {
    for (const handlerKey of [Handlers.DHIS2_INSTANCE_PULL, Handlers.DHIS2_INSTANCE_PUSH]) {
      const { db: client } = db(instance([], OrgUnitMatch.ID));
      const config = { routeCode: ROUTE, items: [], orgUnitMatch: "code" };
      expect(await resolveInstanceMappings(client, handlerKey, config)).toEqual({
        ...config,
        orgUnitMatch: "id",
      });
    }
  });

  it("keeps the step's own org unit match when the instance has no settings", async () => {
    const { db: client } = db(null);
    const config = { routeCode: ROUTE, items: [], orgUnitMatch: "code" };
    expect(await resolveInstanceMappings(client, Handlers.DHIS2_INSTANCE_PUSH, config)).toEqual(
      config
    );
  });
});
