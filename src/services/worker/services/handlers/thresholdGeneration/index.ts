import path from "node:path";
import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils/env.ts";
import { getAnalyticsData } from "@/services/worker/utils/dhis2.ts";
import {
  generateSubPeriods,
  getHistoricalSubPeriods,
  getHistoricalWindowPeriods,
} from "@/services/worker/utils/periods.ts";
import { calculateThreshold, isCsumCalculationMethod } from "@/services/worker/utils/statistics.ts";
import type { DataValue, DataValueSet } from "@/services/worker/types/data.ts";
import { thresholdGenerationConfigSchema } from "@/services/worker/services/handlers/thresholdGeneration/schemas/config.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import {
  collectHistoricalWindowValues,
  MIN_CSUM_WINDOW_VALUES,
  outputSpecsNeedCsumWindow,
  resolveOutputSpecs,
} from "@/services/worker/services/handlers/thresholdGeneration/utils/outputSpecs.ts";
import { uniqueDataValueSetFilename } from "@/services/worker/utils/dataValueSetFile.ts";

// ============================================================
// Handler
// ============================================================
/**
 * Handler: threshold-generation
 *
 * Generates epidemiological threshold data values for DHIS2. For each org unit
 * and each sub-period within the target years, it fetches historical data and
 * applies WHO-style statistical methods (mean/SD, 25th/75th percentile, C-SUM family).
 *
 * Single output: calculationMethod + outputDataElementId
 * Batch output: outputs[] with one data element per method
 *
 * Output: { filename: string; count: number }
 */
export const thresholdGeneration: StepHandler = {
  async execute(ctx) {
    const config = thresholdGenerationConfigSchema.parse(ctx.handlerConfig);

    const outputSpecs = resolveOutputSpecs(config);
    const needsCsumWindow = outputSpecsNeedCsumWindow(outputSpecs);

    await ctx.log("INFO", "Starting threshold generation", {
      periodType: config.period.periodType,
      years: config.period.years,
      yearsToInclude: config.period.yearsToInclude,
      methods: outputSpecs.map((s) => s.calculationMethod),
    });

    // ── Task 1: resolve org unit IDs ──────────────────────────────────────
    const orgUnitIds = await resolveOrgUnitsWithTask(ctx, config.orgUnit);

    const resolvePeriodTask = await ctx.tasks.startTask("resolve-periods", {
      period: config.period,
    });
    const allHistoricalPeriods = new Set<string>();
    try {
      for (const yearStr of config.period.years) {
        const year = parseInt(yearStr, 10);
        const subPeriods = generateSubPeriods(year, config.period.periodType);
        for (const subPeriod of subPeriods) {
          const historical = getHistoricalSubPeriods(subPeriod, year, config.period.yearsToInclude);
          for (const hp of historical) allHistoricalPeriods.add(hp);

          if (needsCsumWindow) {
            for (const wp of getHistoricalWindowPeriods(
              subPeriod,
              year,
              config.period.yearsToInclude
            )) {
              allHistoricalPeriods.add(wp);
            }
          }
        }
      }
      await resolvePeriodTask.succeed({
        periodCount: allHistoricalPeriods.size,
      });
    } catch (error) {
      await resolvePeriodTask.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    // ── Task 2: fetch analytics data ──────────────────────────────────────
    const task2 = await ctx.tasks.startTask("fetch-analytics-data", {
      periodCount: allHistoricalPeriods.size,
      orgUnitCount: orgUnitIds.length,
    });

    let rows: Awaited<ReturnType<typeof getAnalyticsData>>;
    try {
      rows = await getAnalyticsData({
        dataElementIds: config.dataElementIds,
        periods: [...allHistoricalPeriods],
        orgUnitIds,
        aggregationType: config.aggregationType,
        ctx,
      });

      if (rows.length === 0) {
        await ctx.log("WARN", "No analytics data returned; threshold output will be empty");
      }

      await task2.succeed({ rowCount: rows.length });
    } catch (err) {
      await task2.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Fetched analytics data", { rowCount: rows.length });

    // ── Task 3: calculate threshold values ────────────────────────────────
    const task3 = await ctx.tasks.startTask("calculate-thresholds", {
      methods: outputSpecs.map((s) => s.calculationMethod),
    });

    let dataValues: DataValue[];
    try {
      const aggregated = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.orgUnit}:${row.period}`;
        aggregated.set(key, (aggregated.get(key) ?? 0) + row.value);
      }

      dataValues = [];
      for (const yearStr of config.period.years) {
        const year = parseInt(yearStr, 10);
        const subPeriods = generateSubPeriods(year, config.period.periodType);

        for (const subPeriod of subPeriods) {
          const historicalPeriods = getHistoricalSubPeriods(
            subPeriod,
            year,
            config.period.yearsToInclude
          );

          for (const orgUnit of orgUnitIds) {
            const historicalValues = historicalPeriods
              .map((p) => aggregated.get(`${orgUnit}:${p}`))
              .filter((v): v is number => v !== undefined);

            const windowValues = needsCsumWindow
              ? collectHistoricalWindowValues(
                  orgUnit,
                  subPeriod,
                  year,
                  config.period.yearsToInclude,
                  config.period.periodType,
                  aggregated
                )
              : [];

            for (const spec of outputSpecs) {
              if (
                !isCsumCalculationMethod(spec.calculationMethod) &&
                historicalValues.length === 0
              ) {
                continue;
              }
              if (
                isCsumCalculationMethod(spec.calculationMethod) &&
                windowValues.length < MIN_CSUM_WINDOW_VALUES
              ) {
                continue;
              }

              const threshold = calculateThreshold(
                spec.calculationMethod,
                historicalValues,
                isCsumCalculationMethod(spec.calculationMethod) ? { windowValues } : undefined
              );

              if (!isFinite(threshold) || isNaN(threshold)) continue;

              dataValues.push({
                dataElement: spec.outputDataElementId,
                period: subPeriod,
                orgUnit,
                value: String(Math.round(threshold)),
              });
            }
          }
        }
      }

      await task3.succeed({ dataValueCount: dataValues.length });
    } catch (err) {
      await task3.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Calculated threshold values", { count: dataValues.length });

    const outputFilename = uniqueDataValueSetFilename("threshold");

    // ── Task 4: write output file ─────────────────────────────────────────
    const task4 = await ctx.tasks.startTask("write-output-file", {
      filename: outputFilename,
    });

    const filePath = path.resolve(env.OUTPUTS_DIR, outputFilename);
    try {
      const payload: DataValueSet = { dataValues };
      await Bun.write(filePath, JSON.stringify(payload));
      await task4.succeed({ filePath, count: dataValues.length });
    } catch (err) {
      await task4.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Threshold generation complete", {
      filename: outputFilename,
      count: dataValues.length,
    });

    return { filename: outputFilename, count: dataValues.length };
  },
};

registerHandler(Handlers.THRESHOLD_GENERATION, thresholdGeneration);
