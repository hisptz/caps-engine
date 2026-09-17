import {
  registerHandler,
  StepSkippedError,
  type StepHandler,
} from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils/env.ts";
import path from "node:path";
import type { TrackerImportBody, TrackerImportReport } from "@/services/worker/types/tracker.ts";
import { postTrackerEvents } from "@/services/worker/utils/dhis2.ts";
import { AxiosError } from "axios";

/**
 * Handler: event-data-upload
 *
 * Reads a tracker import JSON file from OUTPUTS_DIR and POSTs it to DHIS2 POST /tracker/.
 *
 * Requires ctx.input from the previous step (e.g. alert-generation):
 * { filename?: string; count: number }
 *
 * When count is 0 the step is marked SKIPPED (no file upload).
 *
 * Output:
 * { status: string; created: number; updated: number; ignored: number; deleted: number }
 */
export const eventDataUpload: StepHandler = {
  async execute(ctx) {
    const input = ctx.input as { filename?: string; count?: number } | undefined;
    const count = input?.count ?? 0;

    if (count === 0) {
      throw new StepSkippedError("No tracker events to upload", {
        count: 0,
        status: "SKIPPED",
      });
    }

    const filename = input?.filename;

    if (!filename) {
      throw new Error(
        "event-data-upload requires { filename } when count is greater than 0 (basename under OUTPUTS_DIR)"
      );
    }

    const filePath = path.resolve(env.OUTPUTS_DIR, filename);

    await ctx.log("INFO", "Reading tracker events file", { filePath });

    const task = await ctx.tasks.startTask("upload-tracker-events", {
      filePath,
    });

    let payload: TrackerImportBody;
    try {
      const file = Bun.file(filePath);
      payload = (await file.json()) as TrackerImportBody;
    } catch (err) {
      const error = new Error(
        `Failed to read tracker events file at "${filePath}": ${String(err)}`
      );
      await task.fail(error);
      throw error;
    }

    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      const error = new Error(`Tracker events file "${filePath}" contains no events`);
      await task.fail(error);
      throw error;
    }

    await ctx.log("INFO", "Uploading tracker events to DHIS2", {
      filePath,
      count: payload.events.length,
    });

    let summary: TrackerImportReport;
    try {
      summary = await postTrackerEvents({ payload, ctx, importStrategy: "CREATE" });
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 409) {
        summary = err.response.data as TrackerImportReport;
        await task.fail(err);
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        await task.fail(error);
        throw error;
      }
    }

    if (summary.status === "ERROR") {
      const error = new Error("DHIS2 tracker import failed with status ERROR");
      await task.fail(error);
      throw error;
    }

    const stats = summary.stats ?? {
      created: 0,
      updated: 0,
      ignored: 0,
      deleted: 0,
      total: 0,
    };

    const result = {
      status: summary.status,
      created: stats.created,
      updated: stats.updated,
      ignored: stats.ignored,
      deleted: stats.deleted,
    };

    await task.succeed(result);
    await ctx.log("INFO", "DHIS2 tracker import complete", result);

    return result;
  },
};

registerHandler(Handlers.EVENT_DATA_UPLOAD, eventDataUpload);
