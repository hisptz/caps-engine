import path from "node:path";
import { resolvePullPeriods } from "@/services/worker/services/handlers/dhis2InstancePull/utils/periods.ts";
import { StepPermanentError, type StepHandler } from "@/services/worker/types/service.ts";
import { uniqueDataValueSetFilename } from "@/services/worker/utils/dataValueSetFile.ts";
import { createRouteClient, describeRouteError } from "@/shared/clients/dhis.ts";
import { env } from "@/shared/utils/env.ts";
import {
  httpDataPullConfigSchema,
  remoteDataValueSchema,
  type RemoteDataValue,
} from "./schemas/config.ts";

/** What the step returns: shown in the run history and offered to connector conditions. */
export type HttpDataPullOutput = {
  /** File under OUTPUTS_DIR that the DHIS2 Data Upload step reads */
  filename: string;
  allowEmpty: boolean;
  count: number;
  skipped: number;
  periods: string[];
};

/**
 *  This example expects DHIS2's own shape,
 * `{ dataValues: [{ dataElement, period, orgUnit, value, … }] }`.
 */
export function toDataValues(
  body: unknown,
  wanted: { dataElements: Set<string>; periods: Set<string> }
): { dataValues: RemoteDataValue[]; skipped: number } {
  const rows = (body as { dataValues?: unknown } | null)?.dataValues;
  if (!Array.isArray(rows)) {
    throw new StepPermanentError(
      'The endpoint did not return { "dataValues": [...] }. Check the endpoint path.'
    );
  }
  const dataValues: RemoteDataValue[] = [];
  for (const row of rows) {
    const parsed = remoteDataValueSchema.safeParse(row);
    if (
      parsed.success &&
      wanted.dataElements.has(parsed.data.dataElement) &&
      wanted.periods.has(parsed.data.period)
    ) {
      dataValues.push(parsed.data);
    }
  }
  return { dataValues, skipped: rows.length - dataValues.length };
}

/**
 * Handler: http-data-pull
 *
 * Asks your system for the chosen data elements and periods, keeps the values in DHIS2's
 * shape, and writes them to a file for the next step, DHIS2 Data Upload, which imports them
 * into staging. Your system is reached through a route on staging, so its address and
 * credentials stay on staging and never in CAPS.
 *
 * Request: GET <route>/<path>?dataElement=…&period=… (each repeated per value)
 */
export const httpDataPull: StepHandler = {
  async execute(ctx): Promise<HttpDataPullOutput> {
    // The API checked the config when the step was saved; check again, it may be older.
    const parsed = httpDataPullConfigSchema.safeParse(ctx.handlerConfig ?? {});
    if (!parsed.success) {
      throw new StepPermanentError(`Invalid http-data-pull settings: ${parsed.error.message}`);
    }
    const config = parsed.data;
    const periods = resolvePullPeriods(config.period);

    // A task shows up as its own line under the step in the app, with its input and output.
    const fetchTask = await ctx.tasks.startTask("fetch", {
      routeCode: config.routeCode,
      path: config.path,
      periods,
    });
    let body: unknown;
    try {
      const params = new URLSearchParams();
      for (const id of config.dataElements) params.append("dataElement", id);
      for (const id of periods) params.append("period", id);
      const response = await createRouteClient(config.routeCode).get(config.path, { params });
      body = response.data;
      await fetchTask.succeed({ status: response.status });
    } catch (err) {
      // Thrown errors are retried as the step's retry settings say.
      const error = new Error(describeRouteError(err, config.routeCode));
      await fetchTask.fail(error);
      throw error;
    }

    const { dataValues, skipped } = toDataValues(body, {
      dataElements: new Set(config.dataElements),
      periods: new Set(periods),
    });
    if (skipped > 0) {
      await ctx.log("WARN", "Left out values that were not asked for or not in DHIS2's shape", {
        skipped,
      });
    }
    if (dataValues.length === 0 && !config.allowEmpty) {
      // Waiting will not bring data that is not there yet: fail without retrying.
      throw new StepPermanentError(`Your system has no values for ${periods.join(", ")}`);
    }

    const filename = uniqueDataValueSetFilename("http-data-pull");
    await Bun.write(path.resolve(env.OUTPUTS_DIR, filename), JSON.stringify({ dataValues }));
    await ctx.log("INFO", "Data values written for DHIS2 Data Upload", {
      count: dataValues.length,
      filename,
    });

    return { filename, allowEmpty: config.allowEmpty, count: dataValues.length, skipped, periods };
  },
};
