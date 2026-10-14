import { describe, it, expect } from "vitest";
import { partitionAreaFeatures } from "@/services/worker/services/handlers/climateOpenEoCreate/utils/areaFeatures.ts";
import type { OrgUnitFeature } from "@/services/worker/utils/orgUnitsGeoJSON.ts";

function feature(id: string, geometry: OrgUnitFeature["geometry"]): OrgUnitFeature {
  return {
    id,
    type: "Feature",
    properties: { id, level: "3", parent: "P1", parentGraph: "P1", displayName: id },
    geometry,
  };
}

const ring = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];

describe("partitionAreaFeatures", () => {
  it("keeps polygons and multipolygons as areas", () => {
    const { areas, withoutGeometry, nonArea } = partitionAreaFeatures([
      feature("POLY", { type: "Polygon", coordinates: [ring] }),
      feature("MULTI", { type: "MultiPolygon", coordinates: [[ring]] }),
    ]);
    expect(areas.map((f) => f.id)).toEqual(["POLY", "MULTI"]);
    expect(withoutGeometry).toEqual([]);
    expect(nonArea).toEqual([]);
  });

  it("separates points and other shapes from missing geometry", () => {
    const { areas, withoutGeometry, nonArea } = partitionAreaFeatures([
      feature("POINT", { type: "Point", coordinates: [104.8, 17.4] }),
      feature("LINE", {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
      feature("NONE", null),
      feature("UNSET", undefined),
    ]);
    expect(areas).toEqual([]);
    expect(nonArea.map((f) => f.id)).toEqual(["POINT", "LINE"]);
    expect(withoutGeometry.map((f) => f.id)).toEqual(["NONE", "UNSET"]);
  });
});
