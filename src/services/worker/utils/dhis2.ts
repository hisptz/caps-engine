import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import type { DataValueSet, ImportSummary } from "@/services/worker/types/data.ts";
import type { TrackerImportBody, TrackerImportReport } from "@/services/worker/types/tracker.ts";
import type { StepContext } from "@/services/worker/types/service.ts";
import { chunk, groupBy } from "lodash-es";
import { PeriodUtility } from "@hisptz/dhis2-utils";
import { AxiosError } from "axios";

export type TrackerImportStrategy = "CREATE" | "UPDATE" | "CREATE_AND_UPDATE" | "DELETE";

/**
 * POST /tracker/
 * Imports tracker events into DHIS2 (bulk JSON import).
 */
export async function postTrackerEvents({
  payload,
  ctx,
  importStrategy = "CREATE",
}: {
  payload: TrackerImportBody;
  ctx: StepContext;
  importStrategy?: TrackerImportStrategy;
}): Promise<TrackerImportReport> {
  try {
    const response = await dhis2RestClient.post<TrackerImportReport>("/tracker/", payload, {
      params: {
        importStrategy,
        idScheme: "CODE",
        orgUnitIdScheme: "UID",
        async: false,
      },
    });
    return response.data;
  } catch (error) {
    await ctx.log(
      "ERROR",
      `Failed to upload tracker events: ${error instanceof Error ? error.message : "Unknown Error"}`
    );
    if (error instanceof AxiosError && error.response?.status === 409) {
      await ctx.log(
        "INFO",
        `Conflict error occurred during tracker upload. ${JSON.stringify(error.response?.data)}`
      );
    }
    throw error;
  }
}

/**
 * POST /dataValueSets
 * Imports a set of aggregate data values into DHIS2.
 */
export async function postDataValueSet({
  payload,
  ctx,
}: {
  payload: DataValueSet;
  ctx: StepContext;
}): Promise<ImportSummary> {
  try {
    const response = await dhis2RestClient.post<ImportSummary>("/dataValueSets", payload);
    return response.data;
  } catch (error) {
    await ctx.log(
      "ERROR",
      `Failed to upload data values: ${error instanceof Error ? error.message : "Unknown Error"}`
    );
    if (error instanceof AxiosError) {
      if (error.response?.status === 409) {
        await ctx.log(
          "INFO",
          `Conflict error occurred during data upload. ${JSON.stringify(error.response?.data)}`
        );
      }
    }
    throw error;
  }
}

// ============================================================
// Organisation unit helpers
// ============================================================

type OrgUnitPage = {
  organisationUnits: { id: string }[];
  pager: { page: number; pageCount: number };
};

async function fetchOrgUnitsPaged(queryParams: Record<string, string>): Promise<string[]> {
  const response = await dhis2RestClient.get<OrgUnitPage>("/organisationUnits", {
    params: {
      ...queryParams,
      fields: "id",
      paging: "false",
    },
  });

  return response.data.organisationUnits.map((ou) => ou.id);
}

/** Fetch all org unit IDs at the given hierarchy level. */
export async function getOrgUnitsByLevel(level: number): Promise<string[]> {
  return fetchOrgUnitsPaged({ level: String(level) });
}

/** Fetch org unit IDs for one or more hierarchy levels (union). */
export async function getOrgUnitsByLevels(levels: number[]): Promise<string[]> {
  if (levels.length === 0) {
    return [];
  }
  if (levels.length === 1) {
    return getOrgUnitsByLevel(levels[0]!);
  }

  const ids = new Set<string>();
  for (const level of levels) {
    for (const id of await getOrgUnitsByLevel(level)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** Fetch all org unit IDs belonging to the given org unit group. */
export async function getOrgUnitsByGroup(groupId: string): Promise<string[]> {
  return fetchOrgUnitsPaged({ filter: `organisationUnitGroups.id:eq:${groupId}` });
}

// ============================================================
// Analytics helper
// ============================================================

export interface AnalyticsRow {
  dataElement: string;
  period: string;
  orgUnit: string;
  value: number;
}

type AnalyticsResponse = {
  headers: { name: string }[];
  rows: string[][];
};

/**
 * Fetch analytics data from DHIS2 GET `/analytics` with `params` (serialized to
 * repeated `dimension=` keys). Org units are batched in groups of 50 to avoid
 * excessively long URLs. Column positions are derived from response headers.
 */
export async function getAnalyticsData(params: {
  dataElementIds: string[];
  periods: string[];
  orgUnitIds: string[];
  aggregationType?: string;
  ctx: StepContext;
  dataItemAsDimension?: boolean;
}): Promise<AnalyticsRow[]> {
  const {
    dataElementIds,
    periods,
    orgUnitIds,
    aggregationType = "SUM",
    ctx,
    dataItemAsDimension,
  } = params;
  const batchSize = 50;
  const batches: string[][] = chunk(orgUnitIds, batchSize);

  /* we unfortunately also have to batch periods into their respective years as they are prone to have issues across years*/
  const periodBatches = Object.values(
    groupBy(periods, (period) => PeriodUtility.getPeriodById(period).start.year)
  );

  await ctx.log(
    "INFO",
    `Fetching analytics data from DHIS2 for ${orgUnitIds.length} org units, ${periods.length} periods, ${dataElementIds.length} data elements, aggregation type: ${aggregationType}`
  );
  let batchProcessingCount = 0;

  const allRows: AnalyticsRow[] = [];
  const seenRows = new Set<string>();
  await ctx.log("INFO", `Downloading data in ${batches.length} batches`);

  for (const yearPeriods of periodBatches) {
    const year = PeriodUtility.getPeriodById(yearPeriods[0]!).start.year;
    await ctx.log("INFO", `Downloading data for the year ${year}`);
    for (const batch of batches) {
      await ctx.log("INFO", `Downloading batch ${++batchProcessingCount} of ${batches.length}...`);
      const params = new URLSearchParams({
        skipMeta: "true",
        aggregationType,
      });

      if (dataItemAsDimension) {
        params.append("dimension", `dx:${dataElementIds.join(";")}`);
      } else {
        params.append("filter", `dx:${dataElementIds.join(";")}`);
      }
      params.append("dimension", `pe:${yearPeriods.join(";")}`);
      params.append("dimension", `ou:${batch.join(";")}`);

      try {
        const response = await dhis2RestClient.get<AnalyticsResponse>("/analytics", {
          params,
        });
        const { headers, rows } = response.data;

        const dxIdx = headers.findIndex((h) => h.name === "dx");
        const peIdx = headers.findIndex((h) => h.name === "pe");
        const ouIdx = headers.findIndex((h) => h.name === "ou");
        const valueIdx = headers.findIndex((h) => h.name === "value");
        for (const row of rows) {
          const dataElement = row[dxIdx]!;
          const period = row[peIdx]!;
          const orgUnit = row[ouIdx]!;
          const dedupeKey = `${dataElement}:${period}:${orgUnit}`;
          if (seenRows.has(dedupeKey)) continue;
          seenRows.add(dedupeKey);
          allRows.push({
            dataElement,
            period,
            orgUnit,
            value: parseFloat(row[valueIdx]!),
          });
        }
        await ctx.log("INFO", `Downloaded ${rows.length} rows for ${batchProcessingCount}`);
      } catch (error) {
        await ctx.log(
          "ERROR",
          `Failed to download data for batch ${batchProcessingCount}: ${error instanceof Error ? error.message : "Unknown Error"}`
        );

        if (error instanceof AxiosError) {
          if (error.response?.status === 409) {
            await ctx.log(
              "ERROR",
              `DHIS2 Conflict detected: ${JSON.stringify(error.response?.data)}`
            );
          }
        }

        throw error;
      }
    }
    await ctx.log("INFO", `Downloaded ${batchProcessingCount} batches for the year ${year}`);
    batchProcessingCount = 0;
  }

  return allRows;
}

// ============================================================
// Analytics table generation (resource tables) helpers
// ============================================================

export type DhisTaskNotification = {
  category?: string;
  completed?: boolean;
  id?: string;
  level?: "OFF" | "DEBUG" | "LOOP" | "INFO" | "WARN" | "ERROR";
  message?: string;
  time?: string;
  uid?: string;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNotificationArray(value: unknown): DhisTaskNotification[] {
  if (!Array.isArray(value)) return [];
  const out: DhisTaskNotification[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push({
      category: typeof item.category === "string" ? item.category : undefined,
      completed: typeof item.completed === "boolean" ? item.completed : undefined,
      id: typeof item.id === "string" ? item.id : undefined,
      level:
        item.level === "OFF" ||
        item.level === "DEBUG" ||
        item.level === "LOOP" ||
        item.level === "INFO" ||
        item.level === "WARN" ||
        item.level === "ERROR"
          ? item.level
          : undefined,
      message: typeof item.message === "string" ? item.message : undefined,
      time: typeof item.time === "string" ? item.time : undefined,
      uid: typeof item.uid === "string" ? item.uid : undefined,
      ...item,
    });
  }
  return out;
}

export type DhisTaskMap = Record<string, DhisTaskNotification[]>;

export type AnalyticsTablesRunOptions = {
  lastYears?: number;
  skipAggregate?: boolean;
  skipEnrollment?: boolean;
  skipEvents?: boolean;
  skipOrgUnitOwnership?: boolean;
  skipOutliers?: boolean;
  skipResourceTables?: boolean;
  skipTrackedEntities?: boolean;
  skipValidationResult?: boolean;
};

interface AnalyticsTriggerResponse {
  httpStatus: string;
  httpStatusCode: number;
  status: string;
  message: string;
  response: {
    id: string;
    created: string;
    name: string;
  };
}
/**
 * POST /resourceTables/analytics
 * Triggers analytics table generation in DHIS2.
 */
export async function triggerAnalyticsTablesRun(args: {
  options: AnalyticsTablesRunOptions;
  ctx: StepContext;
}): Promise<AnalyticsTriggerResponse> {
  const { options, ctx } = args;
  try {
    const response = await dhis2RestClient.post<AnalyticsTriggerResponse>(
      "/resourceTables/analytics",
      undefined,
      {
        params: options,
      }
    );
    return response.data;
  } catch (error) {
    await ctx.log(
      "ERROR",
      `Failed to trigger DHIS2 analytics tables run: ${error instanceof Error ? error.message : "Unknown Error"}`
    );
    throw error;
  }
}

/**
 * GET /system/tasks/{jobType}
 * Returns a map of jobId -> notifications.
 */
export async function getTaskMapByJobType(args: {
  jobType: string;
  ctx: StepContext;
}): Promise<DhisTaskMap> {
  const { jobType, ctx } = args;
  try {
    const response = await dhis2RestClient.get(`/system/tasks/${jobType}`);
    const out: DhisTaskMap = {};
    if (!isRecord(response.data)) return out;
    for (const [jobId, v] of Object.entries(response.data)) {
      out[jobId] = parseNotificationArray(v);
    }
    return out;
  } catch (error) {
    await ctx.log(
      "WARN",
      `Failed to fetch DHIS2 tasks for jobType="${jobType}": ${error instanceof Error ? error.message : "Unknown Error"}`
    );
    throw error;
  }
}

/**
 * GET /system/tasks/{jobType}/{jobId}
 * Returns notifications array for a specific job.
 */
export async function getTaskNotifications(args: {
  jobType: string;
  jobId: string;
  ctx: StepContext;
}): Promise<DhisTaskNotification[]> {
  const { jobType, jobId, ctx } = args;
  try {
    const response = await dhis2RestClient.get(`/system/tasks/${jobType}/${jobId}`);
    return parseNotificationArray(response.data);
  } catch (error) {
    await ctx.log(
      "WARN",
      `Failed to fetch DHIS2 task notifications for jobType="${jobType}" jobId="${jobId}": ${
        error instanceof Error ? error.message : "Unknown Error"
      }`
    );
    throw error;
  }
}

function lastNotificationTimeMs(notifications: DhisTaskNotification[]): number | null {
  let max: number | null = null;
  for (const n of notifications) {
    if (!n.time) continue;
    const t = Date.parse(n.time);
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  return max;
}

export function isTaskCompleted(notifications: DhisTaskNotification[]): boolean {
  return notifications.some((n) => n.completed === true);
}

/**
 * For preflight: pick a currently-running job id (incomplete) within lookback.
 */
export function selectRunningJobId(args: {
  tasks: DhisTaskMap;
  nowMs: number;
  lookbackMs: number;
}): string | null {
  const { tasks, nowMs, lookbackMs } = args;
  let best: { jobId: string; lastMs: number } | null = null;
  for (const [jobId, notifications] of Object.entries(tasks)) {
    if (isTaskCompleted(notifications)) continue;
    const lastMs = lastNotificationTimeMs(notifications);
    if (lastMs === null) continue;
    if (nowMs - lastMs > lookbackMs) continue;
    if (!best || lastMs > best.lastMs) best = { jobId, lastMs };
  }
  return best?.jobId ?? null;
}

/**
 * Pick the latest incomplete job id (by notification time).
 *
 * Useful when correlating jobs across retries where a previous attempt may
 * have already triggered the analytics run.
 */
export function selectLatestIncompleteJobId(args: { tasks: DhisTaskMap }): string | null {
  const { tasks } = args;
  let best: { jobId: string; lastMs: number } | null = null;
  for (const [jobId, notifications] of Object.entries(tasks)) {
    if (isTaskCompleted(notifications)) continue;
    const lastMs = lastNotificationTimeMs(notifications);
    if (lastMs === null) continue;
    if (!best || lastMs > best.lastMs) best = { jobId, lastMs };
  }
  return best?.jobId ?? null;
}

/**
 * After triggering: pick the newest job that started producing notifications after `startedAtMs`.
 */
export function selectNewestJobIdAfter(args: {
  tasks: DhisTaskMap;
  startedAtMs: number;
  clockSkewMs: number;
}): string | null {
  const { tasks, startedAtMs, clockSkewMs } = args;
  let best: { jobId: string; lastMs: number } | null = null;
  for (const [jobId, notifications] of Object.entries(tasks)) {
    const lastMs = lastNotificationTimeMs(notifications);
    if (lastMs === null) continue;
    if (lastMs < startedAtMs - clockSkewMs) continue;
    if (!best || lastMs > best.lastMs) best = { jobId, lastMs };
  }
  return best?.jobId ?? null;
}
