import type { OrgUnitFeature } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import type { GeoJsonGeometry } from "@/services/worker/types/geojson.ts";

type AreaGeometry = Extract<GeoJsonGeometry, { type: "Polygon" | "MultiPolygon" }>;

export type AreaFeature = OrgUnitFeature & { geometry: AreaGeometry };

/**
 * Splits org units into those OCS can aggregate and those it cannot.
 *
 * OCS's `aggregate_spatial_weighted` (exactextract, since open-climate-service 53bfc87) only
 * accepts polygons, and one point anywhere fails the whole job with "Unsupported geometry
 * type". Points (facilities) have no area to weight cells by, so they are skipped rather than
 * sent. Drop the non-area split once OCS handles points again.
 */
export function partitionAreaFeatures(features: OrgUnitFeature[]): {
  areas: AreaFeature[];
  withoutGeometry: OrgUnitFeature[];
  nonArea: OrgUnitFeature[];
} {
  const areas: AreaFeature[] = [];
  const withoutGeometry: OrgUnitFeature[] = [];
  const nonArea: OrgUnitFeature[] = [];
  for (const feature of features) {
    const type = feature.geometry?.type;
    if (type === undefined) {
      withoutGeometry.push(feature);
    } else if (type === "Polygon" || type === "MultiPolygon") {
      areas.push(feature as AreaFeature);
    } else {
      nonArea.push(feature);
    }
  }
  return { areas, withoutGeometry, nonArea };
}
