import type { OpenEoJobCreateBody } from "@/shared/clients/openeo.ts";
import type { OrgUnitFeatureCollection } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import {
  openEoPeriodTypeFromConfig,
  temporalExtentFromPeriod,
} from "@/services/worker/utils/period.ts";
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
  const period_type = openEoPeriodTypeFromConfig(config.period.periodType);

  return {
    process: {
      process_graph: {
        agg: {
          process_id: AGGREGATE_TO_DHIS2_ORG_UNITS,
          arguments: {
            dataset_id: config.datasetId,
            temporal_extent,
            geometries,
            data_element_id: config.variable.dataElement,
            method: config.aggregation.method,
            period_type,
          },
          result: true,
        },
      },
    },
    ...(title ? { title } : {}),
  };
}
