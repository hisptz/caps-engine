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
    exportId: "rainfall-monthly",
    aggregation: { method: "mean" },
    period: { periodType: "monthly", id: "202601" },
    orgUnit: { ids: ["OU_ALPHA"] },
  };
}

const pointGeometry = { type: "Point" as const, coordinates: [10, 20] };
const polygonGeometry = {
  type: "Polygon" as const,
  coordinates: [
    [
      [10, 20],
      [11, 20],
      [11, 21],
      [10, 20],
    ],
  ],
};

function orgUnitFeature(
  id: string,
  geometry: typeof pointGeometry | typeof polygonGeometry | null
) {
  return {
    id,
    type: "Feature" as const,
    properties: { id, level: "3", parent: "P1", parentGraph: "P1", displayName: id },
    geometry,
  };
}

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
          geometry: polygonGeometry,
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

  it("skips point org units and sends only areas", async () => {
    mockGetOrgUnits.mockResolvedValue({
      type: "FeatureCollection",
      features: [
        orgUnitFeature("OU_ALPHA", polygonGeometry),
        orgUnitFeature("OU_HOSPITAL", pointGeometry),
        orgUnitFeature("OU_NOGEOM", null),
      ],
    });
    const orgUnitsTask = buildMockTaskHandle();
    const ctx = buildMockContext({
      handlerConfig: baseHandlerConfig(),
      tasks: {
        startTask: vi
          .fn()
          .mockResolvedValueOnce(orgUnitsTask)
          .mockResolvedValue(buildMockTaskHandle()),
      },
    });

    await climateOpenEoCreate.execute(ctx);

    const graph = mockCreateJob.mock.calls[0]![0].process.process_graph.agg as {
      arguments: { geometries: { features: Array<{ id: string }> } };
    };
    expect(graph.arguments.geometries.features.map((f) => f.id)).toEqual(["OU_ALPHA"]);
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("not areas"),
      expect.objectContaining({
        skippedOrgUnits: [{ id: "OU_HOSPITAL", name: "OU_HOSPITAL", geometryType: "Point" }],
        skippedCount: 1,
      })
    );
    expect(orgUnitsTask.succeed).toHaveBeenCalledWith({
      featureCount: 3,
      processableCount: 1,
      skippedCount: 2,
      skippedWithoutGeometryCount: 1,
      skippedNonAreaCount: 1,
    });
  });

  it("fails clearly when every org unit is a point", async () => {
    mockGetOrgUnits.mockResolvedValue({
      type: "FeatureCollection",
      features: [orgUnitFeature("OU_HOSPITAL", pointGeometry)],
    });
    const ctx = buildMockContext({ handlerConfig: baseHandlerConfig() });

    await expect(climateOpenEoCreate.execute(ctx)).rejects.toThrow(
      "No organisation units with an area"
    );
    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});
