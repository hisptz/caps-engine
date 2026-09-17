import { isEmpty } from "lodash-es";
import type { StepContext } from "@/services/worker/types/service.ts";
import type { GeoJsonGeometry } from "@/services/worker/types/geojson.ts";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";

export type OrgUnitSelection = {
  levels?: string[];
  ids?: string[];
};

export type OrgUnitFeatureCollection = {
  type: "FeatureCollection";
  features: OrgUnitFeature[];
};

export type OrgUnitFeature = {
  id: string;
  type: "Feature";
  properties: {
    id: string;
    level: string;
    parent: string;
    parentGraph: string;
    displayName: string;
    code?: string;
  };
  geometry?: GeoJsonGeometry | null;
};

type OrgUnitPayload = {
  id: string;
  displayName: string;
  code?: string;
  geometry?: GeoJsonGeometry | null;
  parent: { id: string };
  level: string;
};

async function getGeoJSONFromOrgUnitPayload({
  orgUnits,
  ctx,
}: {
  orgUnits: OrgUnitPayload[];
  ctx: StepContext;
}): Promise<OrgUnitFeatureCollection> {
  await ctx.log("INFO", "Converting organisation units metadata to GeoJSON");
  return {
    type: "FeatureCollection",
    features: orgUnits.map((orgUnit) => ({
      id: orgUnit.id,
      type: "Feature",
      properties: {
        id: orgUnit.id,
        level: orgUnit.level,
        parent: orgUnit.parent.id,
        parentGraph: orgUnit.parent.id,
        displayName: orgUnit.displayName,
        code: orgUnit.code,
      },
      geometry: orgUnit.geometry,
    })),
  };
}

export async function getOrgUnitsGeoJSON({
  ctx,
  config,
}: {
  config: OrgUnitSelection;
  ctx: StepContext;
}): Promise<OrgUnitFeatureCollection> {
  const { ids, levels } = config;
  await ctx.log("INFO", "Retrieving organisation units metadata");

  const orgUnitParams = new URLSearchParams({
    fields: `id,geometry,parent[id],level,displayName,code`,
    paging: "false",
  });

  if (!isEmpty(ids) && !isEmpty(levels)) {
    await ctx.log(
      "INFO",
      "Both ids and levels are specified, retrieving the resulting organisation unit ids using analytics API"
    );
    const params = new URLSearchParams({
      skipData: "true",
      filter: `pe:${new Date().getFullYear()}`,
      dimension: `ou:${levels!.map((level) => `LEVEL-${level}`).join(";")};${ids!.join(",")}`,
    });
    const response = await dhis2RestClient.get<{
      metaData: { dimensions: { ou: string[] } };
    }>(`analytics`, { params });
    const orgUnitIds = response.data.metaData.dimensions.ou;
    orgUnitParams.append("filter", `id:in:[${orgUnitIds.join(",")}]`);
    const orgUnitResponse = await dhis2RestClient.get<{
      organisationUnits: OrgUnitPayload[];
    }>(`organisationUnits`, { params: orgUnitParams });

    return getGeoJSONFromOrgUnitPayload({
      ctx,
      orgUnits: orgUnitResponse.data.organisationUnits,
    });
  }

  if (!isEmpty(ids)) {
    await ctx.log("INFO", "Only ids are specified, using them as they are");
    orgUnitParams.append("filter", `id:in:[${ids!.join(",")}]`);
    const orgUnitResponse = await dhis2RestClient.get<{
      organisationUnits: OrgUnitPayload[];
    }>(`organisationUnits`, { params: orgUnitParams });

    return getGeoJSONFromOrgUnitPayload({
      ctx,
      orgUnits: orgUnitResponse.data.organisationUnits,
    });
  }

  if (!isEmpty(levels)) {
    await ctx.log(
      "INFO",
      "Only levels are specified, retrieving the resulting organisation unit ids"
    );
    orgUnitParams.append("level", levels!.join(","));
    const orgUnitResponse = await dhis2RestClient.get<{
      organisationUnits: OrgUnitPayload[];
    }>(`organisationUnits`, { params: orgUnitParams });

    return getGeoJSONFromOrgUnitPayload({
      ctx,
      orgUnits: orgUnitResponse.data.organisationUnits,
    });
  }

  await ctx.log("ERROR", "No organisation units specified");
  throw new Error("No organisation units specified");
}
