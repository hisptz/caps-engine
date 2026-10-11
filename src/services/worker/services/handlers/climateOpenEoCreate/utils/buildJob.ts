import type { OpenEoJobCreateBody } from "@/shared/clients/openeo.ts";
import type { OrgUnitFeatureCollection } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import { temporalExtentFromPeriod } from "@/services/worker/utils/period.ts";
import type { ClimateOpenEoConfig } from "../../climateOpenEo/schemas/config.ts";

const AGGREGATE_TO_DHIS2_ORG_UNITS = "aggregate_to_dhis2_json";

export function buildOpenEoJobBody({
  config,
  geometries,
  title,
}: {
  config: ClimateOpenEoConfig;
  geometries: OrgUnitFeatureCollection;
  title?: string;
}): OpenEoJobCreateBody {
  const temporal_extent = temporalExtentFromPeriod(config.period);

  return {
    process: {
      process_graph: {
        agg: {
          process_id: AGGREGATE_TO_DHIS2_ORG_UNITS,
          arguments: {
            dataset_id: config.datasetId,
            temporal_extent,
            geometries,
            export: config.exportId,
            method: config.aggregation.method,
          },
          result: true,
        },
      },
    },
    ...(title ? { title } : {}),
  };
}
