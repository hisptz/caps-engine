import path from "node:path";
import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils";
import { uniqueDataValueSetFilename } from "@/services/worker/utils/dataValueSetFile.ts";
import { dataValueSetSchema } from "@/services/worker/schemas/dataValueSet.ts";
import {
  downloadOpenEoJobResult,
  getOpenEoJobResults,
  resolveResultFilename,
} from "@/shared/clients/openeo.ts";

/**
 * Handler: climate-openeo-download
 *
 * Downloads the DHIS2 dataValueSet result from a finished openEO job and writes
 * it to OUTPUTS_DIR. Can be retried independently of the poll step.
 *
 * Expected input (from climate-openeo-poll): { jobId: string; status: string }
 *
 * Output: { jobId, filename, count }
 */
export const climateOpenEoDownload: StepHandler = {
  async execute(ctx) {
    const input = ctx.input as { jobId?: string; status?: string };
    const jobId = input?.jobId;

    if (!jobId) {
      throw new Error("climate-openeo-download requires { jobId } from the previous step's output");
    }

    await ctx.log("INFO", "Downloading Open Climate Service job result", { jobId });

    const downloadTask = await ctx.tasks.startTask("download-result", { jobId });
    let dataValueSet;
    try {
      await getOpenEoJobResults(jobId);
      const resultFilename = resolveResultFilename();
      const raw = await downloadOpenEoJobResult(jobId, resultFilename);
      const parsed = dataValueSetSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `Open Climate Service result is not a valid DataValueSet: ${parsed.error.message}`
        );
      }
      dataValueSet = parsed.data;
      await downloadTask.succeed({
        resultFilename,
        count: dataValueSet.dataValues.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await downloadTask.fail(error);
      throw error;
    }

    if (dataValueSet.dataValues.length === 0) {
      await ctx.log("WARN", "No climate data values produced for the requested period/extent", {
        jobId,
      });
    }

    const outputFilename = uniqueDataValueSetFilename("climate-openeo");
    const filePath = path.resolve(env.OUTPUTS_DIR, outputFilename);
    const writeTask = await ctx.tasks.startTask("write-file", { filePath });
    try {
      await Bun.write(filePath, JSON.stringify(dataValueSet));
      await writeTask.succeed({ filePath, count: dataValueSet.dataValues.length });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await writeTask.fail(error);
      throw error;
    }

    await ctx.log("INFO", "Open Climate Service data download complete", {
      jobId,
      filename: outputFilename,
      count: dataValueSet.dataValues.length,
    });

    return { jobId, filename: outputFilename, count: dataValueSet.dataValues.length };
  },
};

registerHandler(Handlers.CLIMATE_OPENEO_DOWNLOAD, climateOpenEoDownload);
