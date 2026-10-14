import { describe, it, expect } from "vitest";
import { buildOpenEoJobBody } from "@/services/worker/services/handlers/climateOpenEoCreate/utils/buildJob.ts";
import type { ClimateOpenEoConfig } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";

const config: ClimateOpenEoConfig = {
  datasetId: "era5land_precipitation_monthly",
  exportId: "rainfall-monthly",
  aggregation: { method: "sum" },
  period: { periodType: "monthly", id: "202601" },
  orgUnit: { ids: ["OU_ALPHA"] },
};

const geometries = {
  type: "FeatureCollection" as const,
  features: [
    {
      id: "OU_ALPHA",
      type: "Feature" as const,
      properties: {
        id: "OU_ALPHA",
        level: "3",
        parent: "P1",
        parentGraph: "P1",
        displayName: "Alpha",
      },
      geometry: { type: "Point" as const, coordinates: [10, 20] },
    },
  ],
};

describe("buildOpenEoJobBody", () => {
  it("spans start period to end period when endId is set", () => {
    const body = buildOpenEoJobBody({
      config: {
        ...config,
        period: { periodType: "monthly", id: "202405", endId: "202607" },
      },
      geometries,
    });

    const graph = body.process.process_graph.agg as {
      arguments: Record<string, unknown>;
    };
    expect(graph.arguments).toMatchObject({
      temporal_extent: ["2024-05-01", "2026-07-31"],
    });
  });

  it("builds aggregate_to_dhis2_json process graph", () => {
    const body = buildOpenEoJobBody({ config, geometries, title: "test-job" });

    expect(body.title).toBe("test-job");
    const graph = body.process.process_graph.agg as {
      process_id: string;
      arguments: Record<string, unknown>;
      result: boolean;
    };
    expect(graph.process_id).toBe("aggregate_to_dhis2_json");
    expect(graph.result).toBe(true);
    expect(graph.arguments).toMatchObject({
      dataset_id: "era5land_precipitation_monthly",
      temporal_extent: ["2026-01-01", "2026-01-31"],
      export: "rainfall-monthly",
      method: "sum",
      geometries,
    });
  });

  it("spells out the graph with ad-hoc DHIS2JSON options for a data element", () => {
    const body = buildOpenEoJobBody({
      config: { ...config, exportId: undefined, variable: { dataElement: "QRvJclmKq2g" } },
      geometries,
    });

    const graph = body.process.process_graph;
    expect(graph.agg).toBeUndefined();
    expect(graph.load).toEqual({
      process_id: "load_collection",
      arguments: {
        id: "era5land_precipitation_monthly",
        temporal_extent: ["2026-01-01", "2026-01-31"],
      },
    });
    expect(graph.zonal).toEqual({
      process_id: "aggregate_spatial_weighted",
      arguments: { data: { from_node: "load" }, geometries, reducer: "sum" },
    });
    expect(graph.save).toEqual({
      process_id: "save_result",
      arguments: {
        data: { from_node: "zonal" },
        format: "DHIS2JSON",
        options: {
          data_element_id: "QRvJclmKq2g",
          org_unit_field: "feature_id",
          period_type: "month",
        },
      },
      result: true,
    });
  });
});
