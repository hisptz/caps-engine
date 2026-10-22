import { chunk } from "lodash-es";
import { z } from "zod";
import type { AxiosInstance } from "axios";
import {
  registerHandler,
  StepSkippedError,
  type StepContext,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { createRouteClient, describeRouteError, dhis2RestClient } from "@/shared/clients/dhis.ts";
import { groupConflicts, StepError } from "@/shared/utils/error.ts";
import type { DataValue, ImportSummary } from "@/services/worker/types/data.ts";
import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";
import { periodToOccurredAt } from "@/services/worker/utils/periods.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import { toComboMeta } from "@/services/worker/services/handlers/dhis2InstancePull/utils/categoryCombos.ts";
import {
  isOpenForPeriod,
  matchOrgUnits,
  orgUnitsById,
  type OrgUnitRow,
} from "@/services/worker/services/handlers/dhis2InstancePull/utils/orgUnits.ts";
import { resolvePullPeriods } from "@/services/worker/services/handlers/dhis2InstancePull/utils/periods.ts";
import { analyticsUpTo, type AnalyticsSystemInfo } from "@/shared/utils/sourceAnalytics.ts";
import {
  dhis2InstancePushConfigSchema,
  type Dhis2InstancePushConfig,
  type PushPeriod,
} from "./schemas/config.ts";
import {
  analyticsDxItems,
  mapPushValues,
  planPushItems,
  type PushMeta,
  type PushPlan,
} from "./utils/itemPlans.ts";

export type Dhis2InstancePushOutput = {
  routeCode: string;
  source: Dhis2InstancePushConfig["source"];
  status: string;
  /** Data values read from staging. */
  read: number;
  /** Data values sent to the target. */
  sent: number;
  imported: number;
  updated: number;
  ignored: number;
  deleted: number;
  /** Values left out because their option combo has no match on the target, per data element. */
  unmatchedCombos: Record<string, number>;
  /** Staging org units with no match on the target; their values were left out. */
  skippedOrgUnits: string[];
  /** Values left out because their target org unit is closed for the period. */
  closedValues: number;
  conflicts: number;
  targetVersion: string | null;
};

const stagingDataValueSetSchema = z.object({
  dataValues: z
    .array(
      z.object({
        dataElement: z.string(),
        period: z.string(),
        orgUnit: z.string(),
        categoryOptionCombo: z.string().optional(),
        attributeOptionCombo: z.string().optional(),
        value: z.union([z.string(), z.number()]).transform(String),
      })
    )
    .default([]),
});

const META_FIELDS =
  "id,valueType,aggregationType,categoryCombo[name,isDefault,categoryOptionCombos[id,name]]";

/** Org unit IDs (or codes) per lookup; see dhis2-instance-pull. */
const ORG_UNITS_PER_LOOKUP = 500;

async function findDataElementMeta(
  client: AxiosInstance,
  ids: string[]
): Promise<Map<string, PushMeta>> {
  const found = new Map<string, PushMeta>();
  for (const batch of chunk([...new Set(ids)], 50)) {
    const response = await client.get<{
      dataElements?: Array<Parameters<typeof toComboMeta>[0] & { aggregationType?: string }>;
    }>("dataElements.json", {
      params: { filter: `id:in:[${batch.join(",")}]`, fields: META_FIELDS, paging: "false" },
    });
    for (const dataElement of response.data.dataElements ?? []) {
      found.set(dataElement.id, {
        ...toComboMeta(dataElement),
        aggregationType: dataElement.aggregationType,
      });
    }
  }
  return found;
}

/** Start date (yyyy-MM-dd) of a DHIS2 period ID, or undefined for IDs it can't parse. */
function periodStart(periodId: string): string | undefined {
  try {
    return periodToOccurredAt(periodId).slice(0, 10);
  } catch {
    return undefined;
  }
}

async function runPreflight(
  ctx: StepContext,
  config: Dhis2InstancePushConfig,
  target: AxiosInstance,
  stagingOrgUnits: string[]
): Promise<{
  plans: PushPlan[];
  targetOrgUnitByStaging: Map<string, string>;
  targetUnits: Map<string, OrgUnitRow>;
  skippedOrgUnits: string[];
  targetVersion: string | null;
}> {
  const { routeCode } = config;
  const task = await ctx.tasks.startTask("preflight", {
    routeCode,
    items: config.items.length,
    orgUnits: stagingOrgUnits.length,
  });
  const routeError = (message: string, err: unknown) =>
    new StepError(message, {
      source: "dhis2-route",
      routeCode,
      description: describeRouteError(err, routeCode),
    });
  try {
    let targetVersion: string | null;
    try {
      await target.get("me.json", { params: { fields: "id" } });
      targetVersion =
        (await target.get<{ version?: string }>("system/info.json")).data.version ?? null;
    } catch (err) {
      throw routeError("Target instance route is not usable", err);
    }

    const stagingMeta = await findDataElementMeta(
      dhis2RestClient,
      config.items.map((item) => item.from)
    );
    let targetMeta: Map<string, PushMeta>;
    try {
      targetMeta = await findDataElementMeta(
        target,
        config.items.map((item) => item.into ?? item.from)
      );
    } catch (err) {
      throw routeError("Could not read data elements on the target instance", err);
    }
    const { plans, problems, missingStaging, missingTargets } = planPushItems(
      config.items,
      stagingMeta,
      targetMeta,
      config.source
    );
    if (missingStaging.length > 0 || missingTargets.length > 0) {
      throw new StepError("Push data elements are missing", {
        source: "dhis2-route",
        routeCode,
        description:
          "Edit the step: every listed data element must exist on staging, and its target data element on the target instance. CAPS doesn't create metadata on the target.",
        missingOnStaging: missingStaging,
        missingOnTarget: missingTargets,
      });
    }
    if (problems.length > 0) {
      throw new StepError("Some items can't be written into their target data elements", {
        source: "dhis2-route",
        routeCode,
        description:
          "Edit the step: pick a different target data element for these items, as each item's reason says.",
        items: problems,
      });
    }
    for (const plan of plans) {
      if (plan.mode === "combos" && plan.unmatched.length > 0) {
        await ctx.log(
          "WARN",
          "Some staging option combos have no match on the target; their values are left out",
          { dataElement: plan.from, target: plan.target, unmatched: plan.unmatched }
        );
      }
    }

    const byCode = config.orgUnitMatch === "code";
    const codes = byCode
      ? new Map(
          [
            ...(
              await orgUnitsById(dhis2RestClient, stagingOrgUnits, ORG_UNITS_PER_LOOKUP)
            ).values(),
          ].flatMap((unit) => (unit.code ? [[unit.id, unit.code] as const] : []))
        )
      : undefined;
    let matched: Awaited<ReturnType<typeof matchOrgUnits>>;
    try {
      matched = await matchOrgUnits(target, stagingOrgUnits, ORG_UNITS_PER_LOOKUP, codes);
    } catch (err) {
      throw routeError("Could not check org units on the target instance", err);
    }
    const targetOrgUnitByStaging = new Map(
      [...matched.stagingBySource].map(([targetId, stagingId]) => [stagingId, targetId] as const)
    );
    const skippedOrgUnits = matched.unmatched;
    const withoutCode = codes ? stagingOrgUnits.filter((id) => !codes.has(id)) : [];
    if (targetOrgUnitByStaging.size === 0) {
      throw new StepError(
        byCode
          ? "None of the selected org units have a matching code on the target instance"
          : "None of the selected org units exist on the target instance",
        {
          source: "dhis2-route",
          routeCode,
          missingOrgUnits: skippedOrgUnits.slice(0, 50),
          ...(byCode ? { withoutCode: withoutCode.length } : {}),
        }
      );
    }
    if (skippedOrgUnits.length > 0) {
      await ctx.log(
        "WARN",
        byCode
          ? "Some org units have no matching code on the target instance; their values are left out"
          : "Some org units don't exist on the target instance; their values are left out",
        {
          count: skippedOrgUnits.length,
          orgUnits: skippedOrgUnits.slice(0, 50),
          ...(byCode ? { withoutCode: withoutCode.length } : {}),
        }
      );
    }

    await task.succeed({
      targetVersion,
      orgUnits: targetOrgUnitByStaging.size,
      orgUnitMatch: config.orgUnitMatch,
      skippedOrgUnits: skippedOrgUnits.length,
      summed: plans.filter((p) => p.mode === "sum").map((p) => p.from),
      byOptionCombo: plans.filter((p) => p.mode === "combos").map((p) => p.from),
    });
    return {
      plans,
      targetOrgUnitByStaging,
      targetUnits: matched.sourceUnits,
      skippedOrgUnits,
      targetVersion,
    };
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/** The period filter of a staging read: `lastUpdatedDuration`, or the period IDs to read. */
function periodParams(period: PushPeriod): { lastUpdatedDuration: string } | { periods: string[] } {
  return period.mode === "updated"
    ? { lastUpdatedDuration: `${period.days}d` }
    : { periods: resolvePullPeriods(period) };
}

/** Analytics `dx` items per request; see dhis2-instance-pull. */
const DX_ITEMS_PER_REQUEST = 50;

/**
 * Totals from staging's analytics for the plans' items, rolled up to `orgUnits`, per chunk of
 * org units × periods × items. Analytics only has what its last run saw, so that time is logged.
 */
async function readStagingAnalytics(
  ctx: StepContext,
  config: Dhis2InstancePushConfig,
  plans: PushPlan[],
  orgUnits: string[]
): Promise<DataValue[]> {
  if (config.period.mode === "updated") {
    throw new Error("Analytics can't be read by last update");
  }
  const periods = resolvePullPeriods(config.period);
  const dxChunks = chunk(analyticsDxItems(plans), DX_ITEMS_PER_REQUEST);
  const periodChunks = chunk(periods, config.chunk.periods);
  const orgUnitChunks = chunk(orgUnits, config.chunk.orgUnits);
  const task = await ctx.tasks.startTask("read-staging-analytics", {
    orgUnits: orgUnits.length,
    firstPeriod: periods[0],
    lastPeriod: periods.at(-1),
    requests: dxChunks.length * periodChunks.length * orgUnitChunks.length,
  });
  try {
    const info = (await dhis2RestClient.get<AnalyticsSystemInfo>("system/info.json")).data;
    const lastRun = analyticsUpTo(info);
    if (lastRun) {
      await ctx.log("INFO", "Reading staging analytics", { analyticsUpTo: lastRun });
    } else {
      await ctx.log(
        "WARN",
        "Staging didn't report when its analytics last ran; values may be missing or out of date"
      );
    }
    const values: DataValue[] = [];
    for (const orgUnitChunk of orgUnitChunks) {
      for (const periodChunk of periodChunks) {
        for (const dxChunk of dxChunks) {
          const params = new URLSearchParams();
          params.append("dimension", `dx:${dxChunk.join(";")}`);
          params.append("dimension", `pe:${periodChunk.join(";")}`);
          params.append("dimension", `ou:${orgUnitChunk.join(";")}`);
          params.append("skipRounding", "true");
          const raw = (
            await dhis2RestClient.get<unknown>("analytics/dataValueSet.json", { params })
          ).data;
          const parsed = stagingDataValueSetSchema.safeParse(raw ?? {});
          if (!parsed.success) {
            throw new Error(
              `Staging analytics returned an unexpected data value set: ${parsed.error.message}`
            );
          }
          values.push(...parsed.data.dataValues);
        }
      }
    }
    await task.succeed({ count: values.length, analyticsUpTo: lastRun });
    return values;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/** Raw data values on staging for the listed data elements, `orgUnits` and period filter. */
async function readStagingValues(
  ctx: StepContext,
  config: Dhis2InstancePushConfig,
  orgUnits: string[]
): Promise<DataValue[]> {
  const filter = periodParams(config.period);
  const batches = chunk(orgUnits, config.chunk.orgUnits);
  const task = await ctx.tasks.startTask("read-staging", {
    orgUnits: orgUnits.length,
    requests: batches.length,
    ...("periods" in filter
      ? { firstPeriod: filter.periods[0], lastPeriod: filter.periods.at(-1) }
      : filter),
  });
  try {
    const values: DataValue[] = [];
    for (const batch of batches) {
      const params = new URLSearchParams();
      for (const item of config.items) params.append("dataElement", item.from);
      for (const orgUnit of batch) params.append("orgUnit", orgUnit);
      if ("periods" in filter) {
        for (const period of filter.periods) params.append("period", period);
      } else {
        params.append("lastUpdatedDuration", filter.lastUpdatedDuration);
      }
      const raw = (await dhis2RestClient.get<unknown>("dataValueSets.json", { params })).data;
      const parsed = stagingDataValueSetSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        throw new Error(`Staging returned an unexpected data value set: ${parsed.error.message}`);
      }
      values.push(...parsed.data.dataValues);
    }
    await task.succeed({ count: values.length });
    return values;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * Handler: dhis2-instance-push
 *
 * Sends data values from staging to a connected DHIS2 instance, through a `caps-src-` route on
 * staging: the counterpart of dhis2-instance-pull. It reads staging itself, so it works as a
 * pipeline of its own (e.g. a weekly push to the HMIS) or as the last step after an upload.
 *
 *   1. Resolve the selected staging org units.
 *   2. Preflight: the route works, every listed data element exists on staging and its target
 *      on the target instance, their option combos line up (see `planPushItems`), and the
 *      selected org units have a match on the target by ID or code (unmatched ones are skipped
 *      with a warning). Nothing is created on the target.
 *   3. Read values from staging, per chunk: with `source: "raw"`, data values as entered at
 *      the selected org units (GET /dataValueSets), updated in the last `period.days` days or
 *      for a range of periods; with `source: "analytics"`, totals rolled up to the selected org
 *      units for a range of periods (GET /analytics/dataValueSet, as of the last analytics run).
 *      None found skips the step.
 *   4. Map values to target IDs, leaving out values for target org units closed in the period
 *      (DHIS2 would reject them), and POST /dataValueSets in chunks of `chunk.values`, one task
 *      each. A chunk the target rejects (status ERROR) fails the step; chunks before it are
 *      already stored.
 *
 * Config: Dhis2InstancePushConfig. Output: Dhis2InstancePushOutput.
 */
export const dhis2InstancePush: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2InstancePushConfigSchema.safeParse(ctx.handlerConfig);
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-instance-push handlerConfig: ${parsed.error.message}`);
    }
    const config = parsed.data;
    const { routeCode, importStrategy } = config;

    await ctx.log("INFO", "Pushing data values to a connected instance", {
      routeCode,
      items: config.items.length,
      source: config.source,
      period: config.period,
    });

    const stagingOrgUnits = await resolveOrgUnitsWithTask(ctx, config.orgUnit);
    const target = createRouteClient(routeCode);
    const { plans, targetOrgUnitByStaging, targetUnits, skippedOrgUnits, targetVersion } =
      await runPreflight(ctx, config, target, stagingOrgUnits);

    const orgUnitsToRead = [...targetOrgUnitByStaging.keys()];
    const values =
      config.source === "analytics"
        ? await readStagingAnalytics(ctx, config, plans, orgUnitsToRead)
        : await readStagingValues(ctx, config, orgUnitsToRead);
    if (values.length === 0) {
      throw new StepSkippedError(
        config.source === "raw"
          ? "No values stored on staging at the selected org units; values stored at a lower level need the analytics source"
          : "No values in staging analytics to push; check that analytics ran after the values were saved",
        { count: 0 }
      );
    }

    const starts = new Map<string, string | undefined>();
    const mapped = mapPushValues(values, plans, targetOrgUnitByStaging, (orgUnit, period) => {
      if (!starts.has(period)) starts.set(period, periodStart(period));
      const start = starts.get(period);
      return start === undefined || isOpenForPeriod(targetUnits.get(orgUnit), start);
    });
    const { dataValues, unmatchedCombos, closedValues, notNumeric } = mapped;
    if (closedValues > 0) {
      await ctx.log(
        "WARN",
        "Some values are for org units closed (or not yet open) on the target in their period; they are left out",
        { count: closedValues }
      );
    }
    if (notNumeric > 0) {
      await ctx.log(
        "WARN",
        "Some values to add up into a total aren't numbers; they are left out",
        {
          count: notNumeric,
        }
      );
    }
    if (dataValues.length === 0) {
      throw new StepError("No values left to push after matching them to the target", {
        source: "dhis2-route",
        routeCode,
        description:
          "Every value read from staging was left out: its option combo has no match on the target, or its org unit is closed there.",
        read: values.length,
        unmatchedCombos,
        closedValues,
        notNumeric,
      });
    }

    const batches = chunk(dataValues, config.chunk.values);
    const totals = { imported: 0, updated: 0, ignored: 0, deleted: 0 };
    const conflicts: NonNullable<ImportSummary["conflicts"]> = [];
    let status = "SUCCESS";
    for (const [index, batch] of batches.entries()) {
      const label = `${index + 1}/${batches.length}`;
      const task = await ctx.tasks.startTask("push-chunk", {
        chunk: label,
        values: batch.length,
      });
      let summary: ImportSummary;
      try {
        summary = await postDataValueSet({
          payload: { dataValues: batch },
          ctx,
          importStrategy,
          client: target,
        });
      } catch (err) {
        const error = new StepError("Target instance push request failed", {
          source: "dhis2-route",
          routeCode,
          chunk: label,
          description: describeRouteError(err, routeCode),
        });
        await task.fail(error);
        throw error;
      }
      const chunkConflicts = summary.conflicts ?? [];
      conflicts.push(...chunkConflicts);
      if (summary.status === "ERROR") {
        const error = new StepError("The target instance rejected the data value import", {
          source: "dhis2-target",
          routeCode,
          chunk: label,
          chunksStored: index,
          description: summary.description,
          totalConflicts: chunkConflicts.length,
          conflicts: groupConflicts(chunkConflicts),
        });
        await task.fail(error);
        throw error;
      }
      if (summary.status !== "SUCCESS") status = summary.status;
      const counts = summary.importCount ?? { imported: 0, updated: 0, ignored: 0, deleted: 0 };
      totals.imported += counts.imported;
      totals.updated += counts.updated;
      totals.ignored += counts.ignored;
      totals.deleted += counts.deleted;
      await task.succeed({ status: summary.status, ...counts, conflicts: chunkConflicts.length });
    }

    if (conflicts.length > 0) {
      await ctx.log("WARN", "The target instance imported the values with conflicts", {
        status,
        totalConflicts: conflicts.length,
        conflicts: groupConflicts(conflicts),
      });
    }

    const result: Dhis2InstancePushOutput = {
      routeCode,
      source: config.source,
      status,
      read: values.length,
      sent: dataValues.length,
      ...totals,
      unmatchedCombos,
      skippedOrgUnits,
      closedValues,
      conflicts: conflicts.length,
      targetVersion,
    };
    await ctx.log("INFO", "Push complete", {
      ...result,
      skippedOrgUnits: skippedOrgUnits.length,
    });
    return result;
  },
};

registerHandler(Handlers.DHIS2_INSTANCE_PUSH, dhis2InstancePush);
