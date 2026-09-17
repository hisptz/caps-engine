import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "../utils/helpers.ts";

vi.mock("@/services/worker/utils/orgUnitsGeoJSON.ts", () => ({
  getOrgUnitsGeoJSON: vi.fn(),
}));

vi.mock("@/shared/clients/openeo.ts", () => ({
  createOpenEoJob: vi.fn(),
  startOpenEoJob: vi.fn(),
}));

import { climateOpenEoCreate } from "@/services/worker/services/handlers/climateOpenEoCreate/index.ts";
import { getOrgUnitsGeoJSON } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import { createOpenEoJob, startOpenEoJob } from "@/shared/clients/openeo.ts";

const mockGetOrgUnits = vi.mocked(getOrgUnitsGeoJSON);
const mockCreateJob = vi.mocked(createOpenEoJob);
const mockStartJob = vi.mocked(startOpenEoJob);

function baseHandlerConfig(): Record<string, unknown> {
  return {
    datasetId: "era5land_precipitation_monthly",
    variable: { dataElement: "AbCdEfGhIjK" },
    aggregation: { method: "mean" },
    period: { periodType: "monthly", id: "202601" },
    orgUnit: { ids: ["OU_ALPHA"] },
  };
}

const pointGeometry = { type: "Point" as const, coordinates: [10, 20] };

describe("climateOpenEoCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrgUnits.mockResolvedValue({
      type: "FeatureCollection",
      features: [
        {
          id: "OU_ALPHA",
          type: "Feature",
          properties: {
            id: "OU_ALPHA",
            level: "3",
            parent: "P1",
            parentGraph: "P1",
            displayName: "Alpha",
          },
          geometry: pointGeometry,
        },
      ],
    });
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "created" });
    mockStartJob.mockResolvedValue(undefined);
  });

  it("creates and starts an openEO job", async () => {
    const taskHandles = [buildMockTaskHandle(), buildMockTaskHandle(), buildMockTaskHandle()];
    let callIndex = 0;
    const ctx = buildMockContext({
      handlerConfig: baseHandlerConfig(),
      tasks: {
        startTask: vi.fn().mockImplementation(() => Promise.resolve(taskHandles[callIndex++])),
      },
    });

    const result = (await climateOpenEoCreate.execute(ctx)) as { jobId: string };

    expect(result.jobId).toBe("job-123");
    expect(mockCreateJob).toHaveBeenCalledOnce();
    expect(mockStartJob).toHaveBeenCalledWith("job-123");
    const jobBody = mockCreateJob.mock.calls[0]![0];
    const graph = jobBody.process.process_graph.agg as { process_id: string };
    expect(graph.process_id).toBe("aggregate_to_dhis2_json");
  });

  it("fails on invalid config", async () => {
    const ctx = buildMockContext({ handlerConfig: { datasetId: "" } });
    await expect(climateOpenEoCreate.execute(ctx)).rejects.toThrow(
      "Invalid climateOpenEoCreate config"
    );
  });
});
