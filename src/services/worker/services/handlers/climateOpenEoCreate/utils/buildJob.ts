import type { OpenEoJobCreateBody } from "@/shared/clients/openeo.ts";
import type { OrgUnitFeatureCollection } from "@/services/worker/utils/orgUnitsGeoJSON.ts";
import {
  openEoPeriodTypeFromConfig,
  temporalExtentFromPeriod,
} from "@/services/worker/utils/period.ts";
import type { ClimateOpenEoConfig } from "../../climateOpenEo/schemas/config.ts";

const AGGREGATE_TO_DHIS2_ORG_UNITS = "aggregate_to_dhis2_json";

/**
 * With `exportId`, runs OCS's `aggregate_to_dhis2_json` workflow, whose named export owns the
 * data element mapping. With `variable.dataElement`, spells out the same three steps so
 * `save_result` can take the ad-hoc DHIS2JSON options (the workflow only accepts `export`).
 */
export function buildOpenEoJobBody({
  config,
  geometries,
  temporalExtent,
  title,
}: {
  config: ClimateOpenEoConfig;
  geometries: OrgUnitFeatureCollection;
  temporalExtent?: [string, string];
  title?: string;
}): OpenEoJobCreateBody {
  const temporal_extent = temporalExtent ?? temporalExtentFromPeriod(config.period);

  const process_graph =
    config.exportId !== undefined
      ? {
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
        }
      : {
          load: {
            process_id: "load_collection",
            arguments: { id: config.datasetId, temporal_extent },
          },
          zonal: {
            process_id: "aggregate_spatial_weighted",
            arguments: {
              data: { from_node: "load" },
              geometries,
              reducer: config.aggregation.method,
            },
          },
          save: {
            process_id: "save_result",
            arguments: {
              data: { from_node: "zonal" },
              format: "DHIS2JSON",
              options: {
                data_element_id: config.variable!.dataElement,
                org_unit_field: "feature_id",
                period_type: openEoPeriodTypeFromConfig(config.period.periodType),
              },
            },
            result: true,
          },
        };

  return {
    process: { process_graph },
    ...(title ? { title } : {}),
  };
}
