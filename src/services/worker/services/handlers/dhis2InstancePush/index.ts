import path from "node:path";
import { chunk } from "lodash-es";
import { z } from "zod";
import type { AxiosInstance } from "axios";
import {
  StepPermanentError,
  StepSkippedError,
  type StepContext,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { createRouteClient, describeRouteError, dhis2RestClient } from "@/shared/clients/dhis.ts";
import { StepError } from "@/shared/utils/error.ts";
import { env } from "@/shared/utils/env.ts";
import type { DataValue } from "@/services/worker/types/data.ts";
import { sendDataValues } from "@/services/worker/utils/sendDataValues.ts";
import { periodToOccurredAt } from "@/services/worker/utils/periods.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import { hasOrgUnitSelection } from "@/services/worker/schemas/orgUnit.ts";
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
  resolvedPushConfigSchema,
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
  /** Data values read from staging, or from the previous step's file. */
  read: number;
  /** Values in the previous step's file for data elements the step doesn't push; left out. */
  unlisted: number;
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

/** The period of a staging read; the schema requires one unless the source is the previous step. */
function stagingPeriod(config: Dhis2InstancePushConfig): PushPeriod {
  if (!config.period) {
    throw new Error("Reading staging needs a period");
  }
  return config.period;
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
  const period = stagingPeriod(config);
  if (period.mode === "updated") {
    throw new Error("Analytics can't be read by last update");
  }
  const periods = resolvePullPeriods(period);
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
  const filter = periodParams(stagingPeriod(config));
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
 * The data value set file the previous step wrote (`ctx.input.filename`, under OUTPUTS_DIR),
 * e.g. by dhis2-instance-pull. Its values are in staging IDs.
 */
async function readPreviousStepFile(ctx: StepContext): Promise<DataValue[]> {
  const input = ctx.input as { filename?: unknown } | undefined;
  const filename = typeof input?.filename === "string" ? input.filename : undefined;
  if (!filename) {
    throw new StepPermanentError(
      "The push reads the previous step's values, but the previous step left no data value file. Put it after a step that writes one, such as DHIS2 Instance Pull."
    );
  }
  const filePath = path.resolve(env.OUTPUTS_DIR, filename);
  const task = await ctx.tasks.startTask("read-file", { filePath });
  try {
    let raw: unknown;
    try {
      raw = await Bun.file(filePath).json();
    } catch (err) {
      throw new Error(`Failed to read data value set file at "${filePath}": ${String(err)}`, {
        cause: err,
      });
    }
    const parsed = stagingDataValueSetSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new StepPermanentError(
        `The previous step's file isn't a data value set: ${parsed.error.message}`
      );
    }
    await task.succeed({ count: parsed.data.dataValues.length });
    return parsed.data.dataValues;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/** The step's org units; the schema requires them unless the source is the previous step. */
function requiredOrgUnit(config: Dhis2InstancePushConfig) {
  if (!hasOrgUnitSelection(config.orgUnit)) {
    throw new Error("Reading staging needs org units");
  }
  return config.orgUnit;
}

/**
 * The previous step's values for the listed data elements, and the org units to send: the
 * file's, narrowed to the step's own selection when it has one. No values skips the step.
 */
async function readFileValues(
  ctx: StepContext,
  config: Dhis2InstancePushConfig
): Promise<{ values: DataValue[]; orgUnits: string[]; read: number; unlisted: number }> {
  const all = await readPreviousStepFile(ctx);
  if (all.length === 0) {
    throw new StepSkippedError("The previous step found no values to push", { count: 0 });
  }
  const listed = new Set(config.items.map((item) => item.from));
  const values = all.filter((value) => listed.has(value.dataElement));
  const unlisted = all.length - values.length;
  if (unlisted > 0) {
    await ctx.log(
      "WARN",
      "The previous step's file has values for data elements this step doesn't push; they are left out",
      {
        count: unlisted,
        dataElements: [...new Set(all.map((v) => v.dataElement))]
          .filter((id) => !listed.has(id))
          .slice(0, 50),
      }
    );
  }

  let orgUnits = [...new Set(values.map((value) => value.orgUnit))];
  if (hasOrgUnitSelection(config.orgUnit)) {
    const selected = new Set(await resolveOrgUnitsWithTask(ctx, config.orgUnit));
    const outside = orgUnits.filter((id) => !selected.has(id));
    orgUnits = orgUnits.filter((id) => selected.has(id));
    if (outside.length > 0) {
      await ctx.log("INFO", "Values for org units outside the step's selection are left out", {
        orgUnits: outside.length,
      });
    }
  }
  const kept = new Set(orgUnits);
  const sent = values.filter((value) => kept.has(value.orgUnit));
  if (sent.length === 0) {
    throw new StepSkippedError(
      unlisted > 0 && values.length === 0
        ? "None of the previous step's values are for data elements this step pushes"
        : "None of the previous step's values are for the selected org units",
      { count: 0, read: all.length }
    );
  }
  return { values: sent, orgUnits, read: all.length, unlisted };
}

/**
 * Handler: dhis2-instance-push
 *
 * Sends data values to a connected DHIS2 instance, through a `caps-src-` route on staging: the
 * counterpart of dhis2-instance-pull. It reads staging itself, so it works as a pipeline of its
 * own (e.g. a weekly push to the HMIS) or as the last step after an upload. With
 * `source: "previous"` it sends the previous step's file instead, so values move from one
 * instance to another (pull → push) without being stored on staging.
 *
 *   1. Resolve the selected staging org units. With the previous step's file: read it first
 *      (none skips the step), keep the values of the listed data elements, and take the file's
 *      org units, narrowed to the selected ones when the step has some.
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
 *   Step 3 is left out with the previous step's file: its values are already read.
 *
 * Config: Dhis2InstancePushConfig. Output: Dhis2InstancePushOutput.
 */
export const dhis2InstancePush: StepHandler = {
  async execute(ctx) {
    const parsed = resolvedPushConfigSchema.safeParse(ctx.handlerConfig);
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

    const fromFile = config.source === "previous" ? await readFileValues(ctx, config) : undefined;
    const stagingOrgUnits = fromFile
      ? fromFile.orgUnits
      : await resolveOrgUnitsWithTask(ctx, requiredOrgUnit(config));
    const target = createRouteClient(routeCode);
    const { plans, targetOrgUnitByStaging, targetUnits, skippedOrgUnits, targetVersion } =
      await runPreflight(ctx, config, target, stagingOrgUnits);

    const orgUnitsToRead = [...targetOrgUnitByStaging.keys()];
    const values = fromFile
      ? fromFile.values
      : config.source === "analytics"
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

    const { status, conflicts, ...totals } = await sendDataValues(ctx, {
      routeCode,
      dataValues,
      importStrategy,
      chunkSize: config.chunk.values,
      taskName: "push-chunk",
    });

    const result: Dhis2InstancePushOutput = {
      routeCode,
      source: config.source,
      status,
      read: fromFile ? fromFile.read : values.length,
      unlisted: fromFile?.unlisted ?? 0,
      sent: dataValues.length,
      imported: totals.imported,
      updated: totals.updated,
      ignored: totals.ignored,
      deleted: totals.deleted,
      unmatchedCombos,
      skippedOrgUnits,
      closedValues,
      conflicts,
      targetVersion,
    };
    await ctx.log("INFO", "Push complete", {
      ...result,
      skippedOrgUnits: skippedOrgUnits.length,
    });
    return result;
  },
};
