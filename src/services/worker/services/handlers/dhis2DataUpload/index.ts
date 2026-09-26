import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils/env.ts";
import path from "node:path";
import type { DataValueSet, ImportSummary } from "@/services/worker/types/data.ts";
import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";
import { dhis2DataUploadConfigSchema } from "@/services/worker/services/handlers/dhis2DataUpload/schemas/config.ts";

/**
 * Handler: dhis2-data-upload
 *
 * Reads a DataValueSet JSON file from the configured outputs folder and
 * POSTs it to DHIS2 POST /dataValueSets.
 *
 * Requires ctx.input.filename — basename under OUTPUTS_DIR from the previous step
 * (e.g. threshold-generation or prediction-data-download).
 *
 * Config: { importStrategy } — CREATE_AND_UPDATE (default), CREATE or UPDATE.
 *
 * Output:
 * { status: string; imported: number; updated: number; ignored: number; deleted: number }
 */
export const dhis2DataUpload: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2DataUploadConfigSchema.safeParse(ctx.handlerConfig ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-data-upload handlerConfig: ${parsed.error.message}`);
    }
    const { importStrategy } = parsed.data;

    const input = ctx.input as { filename?: string } | undefined;
    const filename = input?.filename;

    if (!filename) {
      throw new Error(
        "dhis2-data-upload requires { filename } from the previous step output (basename under OUTPUTS_DIR)"
      );
    }

    const filePath = path.resolve(env.OUTPUTS_DIR, filename);

    await ctx.log("INFO", "Reading data value set file", { filePath });

    const task = await ctx.tasks.startTask("upload-data-value-set", {
      filePath,
      importStrategy,
    });

    let payload: DataValueSet;
    try {
      const file = Bun.file(filePath);
      payload = (await file.json()) as DataValueSet;
    } catch (err) {
      const error = new Error(
        `Failed to read data value set file at "${filePath}": ${String(err)}`
      );
      await task.fail(error);
      throw error;
    }

    if (!Array.isArray(payload.dataValues) || payload.dataValues.length === 0) {
      const error = new Error(`Data value set file "${filePath}" contains no dataValues`);
      await task.fail(error);
      throw error;
    }

    await ctx.log("INFO", "Uploading data values to DHIS2", {
      filePath,
      count: payload.dataValues.length,
      importStrategy,
    });

    let summary: ImportSummary;
    try {
      summary = await postDataValueSet({ payload, ctx, importStrategy });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await task.fail(error);
      throw error;
    }

    const conflicts = summary.conflicts?.map((c) => `${c.object}: ${c.value}`) ?? [];

    if (summary.status === "ERROR") {
      const error = new Error(
        `DHIS2 data value import failed with status ERROR${conflicts.length ? `: ${conflicts.join("; ")}` : ""}`
      );
      await task.fail(error);
      throw error;
    }

    if (conflicts.length > 0) {
      await ctx.log("WARN", "DHIS2 data value import completed with conflicts", {
        status: summary.status,
        conflicts,
      });
    }

    const counts = summary.importCount ?? {
      imported: 0,
      updated: 0,
      ignored: 0,
      deleted: 0,
    };

    const result = {
      status: summary.status,
      imported: counts.imported,
      updated: counts.updated,
      ignored: counts.ignored,
      deleted: counts.deleted,
    };

    await task.succeed(result);
    await ctx.log("INFO", "DHIS2 data value import complete", result);

    return result;
  },
};

registerHandler(Handlers.DHIS2_DATA_UPLOAD, dhis2DataUpload);
