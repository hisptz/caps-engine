import { beforeEach, describe, expect, it, vi } from "vitest";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { resolveOrgUnitIds } from "@/services/worker/utils/orgUnitSelection.ts";

vi.mock("@/shared/clients/dhis.ts", () => ({
  dhis2RestClient: { get: vi.fn() },
}));

const mockGet = vi.mocked(dhis2RestClient.get);

function orgUnitPage(ids: string[]) {
  return {
    data: {
      organisationUnits: ids.map((id) => ({ id })),
      pager: { page: 1, pageCount: 1 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveOrgUnitIds", () => {
  it("unions ids, levels, and groups", async () => {
    mockGet
      .mockResolvedValueOnce(orgUnitPage(["OU_LEVEL"]))
      .mockResolvedValueOnce(orgUnitPage(["OU_GROUP"]));

    const ids = await resolveOrgUnitIds({
      ids: ["OU_DIRECT"],
      levels: [3],
      groups: ["GROUP1"],
    });

    expect(ids.sort()).toEqual(["OU_DIRECT", "OU_GROUP", "OU_LEVEL"].sort());
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("uses ids only without calling DHIS2", async () => {
    const ids = await resolveOrgUnitIds({ ids: ["OU1", "OU2"] });
    expect(ids).toEqual(["OU1", "OU2"]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
