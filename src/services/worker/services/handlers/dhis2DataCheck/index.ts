import { chunk } from "lodash-es";
import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import { resolvePullPeriods } from "@/services/worker/services/handlers/dhis2InstancePull/utils/periods.ts";
import { dhis2DataCheckConfigSchema } from "@/services/worker/services/handlers/dhis2DataCheck/schemas/config.ts";

export type Dhis2DataCheckOutput = {
  /** Data element × org unit × period combinations with at least one value */
  found: number;
  /** Every combination asked for */
  expected: number;
  /** found / expected, as a percentage with one decimal */
  completeness: number;
  periods: string[];
  orgUnitCount: number;
};

type DataValueRow = { dataElement: string; orgUnit: string; period: string };

/** Repeat each key per value (DHIS2 reads `orgUnit=a&orgUnit=b`, not `orgUnit[]=`). */
function query(params: Record<string, string[]>): string {
  const search = new URLSearchParams();
  for (const [key, values] of Object.entries(params)) {
    for (const value of values) search.append(key, value);
  }
  return search.toString();
}

/** Percentage with one decimal; 0 when nothing was expected. */
export function completenessPercent(found: number, expected: number): number {
  return expected === 0 ? 0 : Math.round((found / expected) * 1000) / 10;
}

/**
 * Handler: dhis2-data-check
 *
 * Answers "is the data already in DHIS2?": counts which of the chosen data elements have a value
 * for each org unit and period, reading the values as entered (dataValueSets), not analytics,
 * which lags until analytics runs. Finding nothing is an answer, not an error: the step succeeds
 * and reports 0, so a connector can decide what to do (e.g. fetch the data first).
 *
 * Config: { dataElements, orgUnit, period, chunkOrgUnits }
 *
 * Output: { found, expected, completeness, periods, orgUnitCount }
 */
export const dhis2DataCheck: StepHandler = {
  async execute(ctx) {
    const parsed = dhis2DataCheckConfigSchema.safeParse(ctx.handlerConfig ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid dhis2-data-check handlerConfig: ${parsed.error.message}`);
    }
    const config = parsed.data;

    const orgUnits = await resolveOrgUnitsWithTask(ctx, config.orgUnit);
    const periods = resolvePullPeriods(config.period);
    const wanted = {
      dataElements: new Set(config.dataElements),
      orgUnits: new Set(orgUnits),
      periods: new Set(periods),
    };

    const task = await ctx.tasks.startTask("count-data-values", {
      dataElements: config.dataElements.length,
      orgUnits: orgUnits.length,
      periods,
    });

    // One entry per data element, org unit and period that has a value (any category option)
    const present = new Set<string>();
    try {
      for (const orgUnitChunk of chunk(orgUnits, config.chunkOrgUnits)) {
        const { data } = await dhis2RestClient.get<{ dataValues?: DataValueRow[] }>(
          `/dataValueSets?${query({
            dataElement: config.dataElements,
            orgUnit: orgUnitChunk,
            period: periods,
          })}`
        );
        for (const value of data.dataValues ?? []) {
          if (
            wanted.dataElements.has(value.dataElement) &&
            wanted.orgUnits.has(value.orgUnit) &&
            wanted.periods.has(value.period)
          ) {
            present.add(`${value.dataElement}|${value.orgUnit}|${value.period}`);
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await task.fail(error);
      throw error;
    }

    const expected = config.dataElements.length * orgUnits.length * periods.length;
    const result: Dhis2DataCheckOutput = {
      found: present.size,
      expected,
      completeness: completenessPercent(present.size, expected),
      periods,
      orgUnitCount: orgUnits.length,
    };

    await task.succeed(result);
    await ctx.log("INFO", "Data check complete", {
      found: result.found,
      expected: result.expected,
      completeness: result.completeness,
      periods,
    });
    return result;
  },
};

registerHandler(Handlers.DHIS2_DATA_CHECK, dhis2DataCheck);
