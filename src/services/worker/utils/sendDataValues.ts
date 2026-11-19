import { chunk } from "lodash-es";
import type { DataValueImportStrategy } from "@/services/worker/services/handlers/dhis2DataUpload/schemas/config.ts";
import type { DataValue, ImportSummary } from "@/services/worker/types/data.ts";
import type { StepContext } from "@/services/worker/types/service.ts";
import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";
import { createRouteClient, describeRouteError } from "@/shared/clients/dhis.ts";
import { groupConflicts, StepError } from "@/shared/utils/error.ts";

export const DEFAULT_SEND_CHUNK_SIZE = 2_000;

export type SendDataValuesOptions = {
  /** Connected instance (`caps-src-…` route on staging) to import into. */
  routeCode: string;
  dataValues: DataValue[];
  importStrategy?: DataValueImportStrategy;
  chunkSize?: number;
  taskName?: string;
};

export type SendDataValuesResult = {
  status: string;
  imported: number;
  updated: number;
  ignored: number;
  deleted: number;
  conflicts: number;
  chunks: number;
};

/**
 * Imports data values into a connected DHIS2 instance through its route: `POST /dataValueSets`
 * in chunks, one task per chunk, adding up DHIS2's import counts.
 *
 * - A request that can't be made (network, timeout, 401/403/404) fails the step with the route's
 *   error described. It is a plain error, so the step may be retried.
 * - A chunk DHIS2 rejects (import status ERROR) fails the step and names how many chunks were
 *   already stored; values of earlier chunks stay on the target.
 * - Conflicts in chunks DHIS2 accepted are logged as one WARN, grouped, and counted.
 *
 * Nothing is sent, and the counts are 0, when `dataValues` is empty.
 */
export async function sendDataValues(
  ctx: StepContext,
  {
    routeCode,
    dataValues,
    importStrategy = "CREATE_AND_UPDATE",
    chunkSize = DEFAULT_SEND_CHUNK_SIZE,
    taskName = "send-chunk",
  }: SendDataValuesOptions
): Promise<SendDataValuesResult> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`chunkSize must be a positive whole number, got ${chunkSize}`);
  }

  const client = createRouteClient(routeCode);
  const batches = chunk(dataValues, chunkSize);
  const totals = { imported: 0, updated: 0, ignored: 0, deleted: 0 };
  const conflicts: NonNullable<ImportSummary["conflicts"]> = [];
  let status = "SUCCESS";

  for (const [index, batch] of batches.entries()) {
    const label = `${index + 1}/${batches.length}`;
    const task = await ctx.tasks.startTask(taskName, { chunk: label, values: batch.length });
    let summary: ImportSummary;
    try {
      summary = await postDataValueSet({
        payload: { dataValues: batch },
        ctx,
        importStrategy,
        client,
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
      routeCode,
      status,
      totalConflicts: conflicts.length,
      conflicts: groupConflicts(conflicts),
    });
  }

  return { status, ...totals, conflicts: conflicts.length, chunks: batches.length };
}
