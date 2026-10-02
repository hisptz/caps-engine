import path from "node:path";
import { chunk } from "lodash-es";
import { z } from "zod";
import type { AxiosInstance } from "axios";
import {
  registerHandler,
  type StepContext,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils/env.ts";
import { createRouteClient, describeRouteError, dhis2RestClient } from "@/shared/clients/dhis.ts";
import { StepError } from "@/shared/utils/error.ts";
import { analyticsUpTo, type AnalyticsSystemInfo } from "@/shared/utils/sourceAnalytics.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import { uniqueDataValueSetFilename } from "@/services/worker/utils/dataValueSetFile.ts";
import {
  dhis2InstancePullConfigSchema,
  pullItemTarget,
  type Dhis2InstancePullConfig,
} from "./schemas/config.ts";
import { periodEnd, resolvePullPeriods } from "./utils/periods.ts";
import { COMBO_FIELDS, toComboMeta, type ComboMeta } from "./utils/categoryCombos.ts";
import { dxItems, planItems, type ItemPlan } from "./utils/itemPlans.ts";

type SourceSystemInfo = AnalyticsSystemInfo & {
  version?: string;
};

type PulledDataValue = {
  dataElement: string;
  period: string;
  orgUnit: string;
  /** Only for items pulled per option combo; totals go into staging's default. */
  categoryOptionCombo?: string;
  value: string;
};

export type Dhis2InstancePullOutput = {
  routeCode: string;
  filename: string;
  allowEmpty: true;
  count: number;
  /** Values written per staging data element. */
  counts: Record<string, number>;
  byOptionCombo: string[];
  periods: string[];
  orgUnits: number;
  skippedOrgUnits: string[];
  sourceAnalyticsUpTo: string | null;
  sourceVersion: string | null;
};

const sourceDataValueSetSchema = z.object({
  dataValues: z
    .array(
      z.object({
        dataElement: z.string(),
        period: z.string(),
        orgUnit: z.string(),
        categoryOptionCombo: z.string().optional(),
        value: z.union([z.string(), z.number()]).transform(String),
      })
    )
    .default([]),
});

type IdList = { id: string }[];

const DX_ITEMS_PER_REQUEST = 50;

async function findMissingIds(
  client: AxiosInstance,
  resource: "dataElements" | "organisationUnits",
  ids: string[],
  batchSize: number
): Promise<string[]> {
  const found = new Set<string>();
  for (const batch of chunk(ids, batchSize)) {
    const response = await client.get<Record<string, IdList>>(`${resource}.json`, {
      params: { filter: `id:in:[${batch.join(",")}]`, fields: "id", paging: "false" },
    });
    for (const { id } of response.data[resource] ?? []) {
      found.add(id);
    }
  }
  return ids.filter((id) => !found.has(id));
}

/** Category combos of the data elements `ids` on `client`, looked up 50 at a time. */
async function findCategoryCombos(
  client: AxiosInstance,
  ids: string[]
): Promise<Map<string, ComboMeta>> {
  const found = new Map<string, ComboMeta>();
  for (const batch of chunk([...new Set(ids)], 50)) {
    const response = await client.get<{ dataElements?: Array<{ id: string }> }>(
      "dataElements.json",
      { params: { filter: `id:in:[${batch.join(",")}]`, fields: COMBO_FIELDS, paging: "false" } }
    );
    for (const dataElement of response.data.dataElements ?? []) {
      found.set(dataElement.id, toComboMeta(dataElement));
    }
  }
  return found;
}

async function runPreflight(
  ctx: StepContext,
  config: Dhis2InstancePullConfig,
  source: AxiosInstance,
  periods: string[]
): Promise<{
  orgUnitIds: string[];
  skippedOrgUnits: string[];
  sourceVersion: string | null;
  sourceAnalyticsUpTo: string | null;
  plans: ItemPlan[];
}> {
  const { routeCode } = config;
  const task = await ctx.tasks.startTask("preflight", { routeCode, periods: periods.length });
  try {
    let info: SourceSystemInfo;
    try {
      await source.get("me.json", { params: { fields: "id" } });
      info = (await source.get<SourceSystemInfo>("system/info.json")).data;
    } catch (err) {
      throw new StepError("Source instance route is not usable", {
        source: "dhis2-route",
        routeCode,
        description: describeRouteError(err, routeCode),
      });
    }

    const stagingCombos = await findCategoryCombos(
      dhis2RestClient,
      config.items.map(pullItemTarget)
    );
    let sourceCombos: Map<string, ComboMeta>;
    try {
      sourceCombos = await findCategoryCombos(
        source,
        config.items.filter((item) => item.fromType === "DATA_ELEMENT").map((item) => item.from)
      );
    } catch (err) {
      throw new StepError("Could not read data elements on the source instance", {
        source: "dhis2-route",
        routeCode,
        description: describeRouteError(err, routeCode),
      });
    }
    const { plans, problems, missingTargets } = planItems(
      config.items,
      stagingCombos,
      sourceCombos
    );
    const missingStagingOrgUnits = config.orgUnit.ids?.length
      ? await findMissingIds(dhis2RestClient, "organisationUnits", config.orgUnit.ids, 50)
      : [];
    if (missingTargets.length > 0 || missingStagingOrgUnits.length > 0) {
      throw new StepError("Pull targets are missing on staging", {
        source: "dhis2",
        description:
          "Pick existing staging data elements for those items in the step, and check the org unit selection.",
        missingDataElements: missingTargets,
        missingOrgUnits: missingStagingOrgUnits,
      });
    }
    if (problems.length > 0) {
      throw new StepError("Some items can't be written into their staging data elements", {
        source: "dhis2",
        description:
          "Edit the step: pick a different staging data element for these items, as each item's reason says.",
        items: problems,
      });
    }

    const stagingOrgUnits = await resolveOrgUnitsWithTask(ctx, config.orgUnit);
    let skippedOrgUnits: string[];
    try {
      skippedOrgUnits = await findMissingIds(
        source,
        "organisationUnits",
        stagingOrgUnits,
        config.chunk.orgUnits
      );
    } catch (err) {
      throw new StepError("Could not check org units on the source instance", {
        source: "dhis2-route",
        routeCode,
        description: describeRouteError(err, routeCode),
      });
    }
    const skipped = new Set(skippedOrgUnits);
    const orgUnitIds = stagingOrgUnits.filter((id) => !skipped.has(id));
    if (orgUnitIds.length === 0) {
      throw new StepError("None of the selected org units exist on the source instance", {
        source: "dhis2-route",
        routeCode,
        missingOrgUnits: skippedOrgUnits,
      });
    }
    if (skippedOrgUnits.length > 0) {
      await ctx.log("WARN", "Some org units don't exist on the source instance and were skipped", {
        count: skippedOrgUnits.length,
        orgUnits: skippedOrgUnits.slice(0, 50),
      });
    }

    const lastGenerated = analyticsUpTo(info);
    const lastPeriod = periods[periods.length - 1]!;
    if (!lastGenerated) {
      await ctx.log("WARN", "The source instance didn't report when its analytics last ran");
    } else if (
      periodEnd(lastPeriod, config.period.periodType).toMillis() > Date.parse(lastGenerated)
    ) {
      await ctx.log(
        "WARN",
        "The source's analytics are older than the end of the pulled periods; recent values may be missing or partial",
        { analyticsUpTo: lastGenerated, lastPeriod }
      );
    }

    await task.succeed({
      sourceVersion: info.version ?? null,
      analyticsUpTo: lastGenerated,
      orgUnits: orgUnitIds.length,
      skippedOrgUnits: skippedOrgUnits.length,
      byOptionCombo: plans.filter((p) => p.mode === "combos").map((p) => p.target),
    });
    return {
      orgUnitIds,
      skippedOrgUnits,
      sourceVersion: info.version ?? null,
      sourceAnalyticsUpTo: lastGenerated,
      plans,
    };
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * Handler: dhis2-instance-pull
 *
 * Pulls aggregate data for the configured data items from a source DHIS2 instance, through a
 * `caps-src-` route on staging, and writes it as a DataValueSet file for `dhis2-data-upload`.
 * Source IDs are rewritten to their staging data elements (and option combos).
 *
 *   1. Preflight: the route works, target data elements and org units exist on staging,
 *      each item's option combos line up (see `planItems`: per option combo when the staging
 *      data element has categories, the total when it has none), org units exist on the source
 *      (missing ones are skipped with a warning), and the source's analytics are recent enough
 *      (warning only).
 *   2. Download `analytics/dataValueSet` (unrounded) in chunks of periods × org units × items,
 *      one task each, with `DE.COC` operands in `dx` for items pulled per option combo.
 *   3. Write one DataValueSet file to OUTPUTS_DIR.
 *
 * Output: Dhis2InstancePullOutput — `filename` feeds dhis2-data-upload.
 */
export const dhis2InstancePull: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2InstancePullConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-instance-pull handlerConfig: ${parsed.error.message}`);
    }
    const config = parsed.data;
    const { routeCode } = config;
    const source = createRouteClient(routeCode);
    const periods = resolvePullPeriods(config.period);

    await ctx.log("INFO", "Pulling data from source instance", {
      routeCode,
      items: config.items.length,
      firstPeriod: periods[0],
      lastPeriod: periods[periods.length - 1],
      periods: periods.length,
    });

    const { orgUnitIds, skippedOrgUnits, sourceVersion, sourceAnalyticsUpTo, plans } =
      await runPreflight(ctx, config, source, periods);

    const totalTarget = new Map<string, string>();
    const comboTarget = new Map<string, { target: string; combo: string }>();
    for (const plan of plans) {
      if (plan.mode === "total") {
        totalTarget.set(plan.from, plan.target);
      } else {
        for (const [sourceCombo, stagingCombo] of plan.stagingComboBySource) {
          comboTarget.set(`${plan.from}.${sourceCombo}`, {
            target: plan.target,
            combo: stagingCombo,
          });
        }
      }
    }
    const dxChunks = chunk(dxItems(plans), DX_ITEMS_PER_REQUEST);
    const periodChunks = chunk(periods, config.chunk.periods);
    const orgUnitChunks = chunk(orgUnitIds, config.chunk.orgUnits);
    const totalChunks = periodChunks.length * orgUnitChunks.length * dxChunks.length;

    const dataValues: PulledDataValue[] = [];
    const counts: Record<string, number> = Object.fromEntries(
      plans.map((plan) => [plan.target, 0])
    );
    let chunkNumber = 0;

    for (const periodChunk of periodChunks) {
      for (const orgUnitChunk of orgUnitChunks) {
        for (const dxChunk of dxChunks) {
          chunkNumber += 1;
          const task = await ctx.tasks.startTask("download-chunk", {
            chunk: `${chunkNumber}/${totalChunks}`,
            periods: periodChunk,
            orgUnits: orgUnitChunk.length,
            items: dxChunk.length,
          });
          try {
            const params = new URLSearchParams();
            params.append("dimension", `dx:${dxChunk.join(";")}`);
            params.append("dimension", `pe:${periodChunk.join(";")}`);
            params.append("dimension", `ou:${orgUnitChunk.join(";")}`);
            // Analytics rounds to display precision by default; staging should get exact values.
            params.append("skipRounding", "true");

            let raw: unknown;
            try {
              raw = (await source.get("analytics/dataValueSet.json", { params })).data;
            } catch (err) {
              throw new StepError("Source analytics request failed", {
                source: "dhis2-route",
                routeCode,
                chunk: `${chunkNumber}/${totalChunks}`,
                description: describeRouteError(err, routeCode),
              });
            }
            const response = sourceDataValueSetSchema.safeParse(raw ?? {});
            if (!response.success) {
              throw new Error(
                `Source analytics returned an unexpected data value set: ${response.error.message}`
              );
            }

            let written = 0;
            let unmapped = 0;
            for (const value of response.data.dataValues) {
              const combo = value.categoryOptionCombo
                ? comboTarget.get(`${value.dataElement}.${value.categoryOptionCombo}`)
                : undefined;
              const target = combo?.target ?? totalTarget.get(value.dataElement);
              if (!target) {
                unmapped += 1;
                continue;
              }
              dataValues.push({
                dataElement: target,
                period: value.period,
                orgUnit: value.orgUnit,
                // Totals carry whatever combo analytics reports; staging stores them under its default.
                ...(combo ? { categoryOptionCombo: combo.combo } : {}),
                value: value.value,
              });
              counts[target] = (counts[target] ?? 0) + 1;
              written += 1;
            }
            if (unmapped > 0) {
              await task.log("WARN", "Source returned values for items that weren't requested", {
                unmapped,
              });
            }
            await task.succeed({ values: written });
          } catch (err) {
            await task.fail(err instanceof Error ? err : new Error(String(err)));
            throw err;
          }
        }
      }
    }

    if (dataValues.length === 0) {
      await ctx.log("WARN", "The source instance returned no values for the requested window", {
        routeCode,
        periods,
      });
    }

    const filename = uniqueDataValueSetFilename("dhis2-instance-pull");
    const filePath = path.resolve(env.OUTPUTS_DIR, filename);
    const writeTask = await ctx.tasks.startTask("write-file", { filePath });
    try {
      await Bun.write(filePath, JSON.stringify({ dataValues }));
      await writeTask.succeed({ filePath, count: dataValues.length });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await writeTask.fail(error);
      throw error;
    }

    const output: Dhis2InstancePullOutput = {
      routeCode,
      filename,
      allowEmpty: true,
      count: dataValues.length,
      counts,
      byOptionCombo: plans.filter((p) => p.mode === "combos").map((p) => p.target),
      periods,
      orgUnits: orgUnitIds.length,
      skippedOrgUnits,
      sourceAnalyticsUpTo: sourceAnalyticsUpTo,
      sourceVersion: sourceVersion,
    };
    await ctx.log("INFO", "Source instance pull complete", {
      ...output,
      periods: periods.length,
      skippedOrgUnits: skippedOrgUnits.length,
    });
    return output;
  },
};

registerHandler(Handlers.DHIS2_INSTANCE_PULL, dhis2InstancePull);
