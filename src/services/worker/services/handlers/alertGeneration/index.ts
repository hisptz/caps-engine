import path from "node:path";
import { registerHandler, type StepHandler } from "@/services/worker/types/service.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { env } from "@/shared/utils/env.ts";
import { getAnalyticsData } from "@/services/worker/utils/dhis2.ts";
import { periodToOccurredAt } from "@/services/worker/utils/periods.ts";
import type { TrackerEvent, TrackerImportBody } from "@/services/worker/types/tracker.ts";
import { parseAlertGenerationConfig } from "@/services/worker/services/handlers/alertGeneration/schemas/config.ts";
import { resolveOrgUnitsWithTask } from "@/services/worker/utils/orgUnitSelection.ts";
import { uniqueDataValueSetFilename } from "@/services/worker/utils/dataValueSetFile.ts";
import {
  ALERT_ACTUAL_VALUE_DE_CODE,
  ALERT_EVENT_STATUS,
  ALERT_PROGRAM_CODE,
  ALERT_PROGRAM_STAGE_CODE,
  ALERT_REPORTING_PERIOD_DE_CODE,
  ALERT_THRESHOLD_VALUE_DE_CODE,
} from "@/services/worker/services/handlers/alertGeneration/constants.ts";
import { compareQuantiles } from "@/services/worker/services/handlers/alertGeneration/utils/compareQuantiles.ts";
import { createFixedPeriodFromPeriodId } from "@dhis2/multi-calendar-dates";

/**
 * Handler: alert-generation
 *
 * Compares aggregate quantile value(s) vs threshold per org unit and period. When any
 * configured quantile value >= threshold, builds a tracker event and writes a JSON file
 * for event-data-upload.
 *
 * Output: { filename?: string; count: number }
 */
export const alertGeneration: StepHandler = {
  async execute(ctx) {
    const config = parseAlertGenerationConfig(ctx.handlerConfig);

    await ctx.log("INFO", "Starting alert generation", {
      periods: config.period.periods,
      thresholdDataElementId: config.thresholdDataElementId,
      valueDataElementIds: config.valueDataElementIds,
    });

    const orgUnitIds = await resolveOrgUnitsWithTask(ctx, config.orgUnit);

    const analyticsDataElementIds = [
      ...new Set([config.thresholdDataElementId, ...config.valueDataElementIds]),
    ];

    const fetchTask = await ctx.tasks.startTask("fetch-analytics-data", {
      periodCount: config.period.periods.length,
      orgUnitCount: orgUnitIds.length,
    });

    let rows: Awaited<ReturnType<typeof getAnalyticsData>>;
    try {
      rows = await getAnalyticsData({
        dataElementIds: analyticsDataElementIds,
        periods: config.period.periods,
        orgUnitIds,
        aggregationType: config.aggregationType,
        ctx,
        dataItemAsDimension: true,
      });

      if (rows.length === 0) {
        await ctx.log("WARN", "No analytics data returned; alert output will be empty");
      }

      await fetchTask.succeed({ rowCount: rows.length });
    } catch (err) {
      await fetchTask.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    const compareTask = await ctx.tasks.startTask("compare-thresholds", {
      orgUnitCount: orgUnitIds.length,
      periodCount: config.period.periods.length,
    });

    let events: TrackerEvent[];
    try {
      const valueByKey = new Map<string, number>();
      for (const row of rows) {
        valueByKey.set(`${row.orgUnit}:${row.period}:${row.dataElement}`, row.value);
      }

      events = [];
      for (const orgUnit of orgUnitIds) {
        for (const periodId of config.period.periods) {
          const thresholdKey = `${orgUnit}:${periodId}:${config.thresholdDataElementId}`;
          const threshold = valueByKey.get(thresholdKey);

          if (threshold === undefined) {
            await ctx.log("WARN", "Skipping org unit/period due to missing threshold", {
              orgUnit,
              periodId,
            });
            continue;
          }

          const quantileValues: number[] = [];
          for (const dataElementId of config.valueDataElementIds) {
            const value = valueByKey.get(`${orgUnit}:${periodId}:${dataElementId}`);
            if (value !== undefined) {
              quantileValues.push(value);
            }
          }

          if (quantileValues.length === 0) {
            await ctx.log("WARN", "Skipping org unit/period due to missing quantile values", {
              orgUnit,
              periodId,
              configuredQuantileCount: config.valueDataElementIds.length,
            });
            continue;
          }

          if (quantileValues.length < config.valueDataElementIds.length) {
            await ctx.log("INFO", "Comparing partial quantile set for org unit/period", {
              orgUnit,
              periodId,
              configuredQuantileCount: config.valueDataElementIds.length,
              presentQuantileCount: quantileValues.length,
            });
          }

          const comparison = compareQuantiles({ threshold, quantileValues });
          if (!comparison.alert) {
            continue;
          }

          // CAPS-ALERT-ACTUAL: max among breaching quantiles (worst-case for dashboards).
          const triggeringValue = comparison.triggeringValue;

          events.push({
            program: ALERT_PROGRAM_CODE,
            programStage: ALERT_PROGRAM_STAGE_CODE,
            orgUnit,
            occurredAt: periodToOccurredAt(periodId),
            status: ALERT_EVENT_STATUS,
            dataValues: [
              { dataElement: ALERT_THRESHOLD_VALUE_DE_CODE, value: String(threshold) },
              { dataElement: ALERT_ACTUAL_VALUE_DE_CODE, value: String(triggeringValue) },
              {
                dataElement: ALERT_REPORTING_PERIOD_DE_CODE,
                value: createFixedPeriodFromPeriodId({
                  periodId,
                  calendar: "iso8601",
                })?.displayName,
              },
            ],
          });
        }
      }

      await compareTask.succeed({ eventCount: events.length });
    } catch (err) {
      await compareTask.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Generated alert events", { count: events.length });

    if (events.length === 0) {
      await ctx.log("INFO", "No alert events generated; skipping output file");
      return { count: 0 };
    }

    const outputFilename = uniqueDataValueSetFilename("alert");
    const writeTask = await ctx.tasks.startTask("write-output-file", {
      filename: outputFilename,
    });

    const filePath = path.resolve(env.OUTPUTS_DIR, outputFilename);
    try {
      const payload: TrackerImportBody = { events };
      await Bun.write(filePath, JSON.stringify(payload));
      await writeTask.succeed({ filePath, count: events.length });
    } catch (err) {
      await writeTask.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await ctx.log("INFO", "Alert generation complete", {
      filename: outputFilename,
      count: events.length,
    });

    return { filename: outputFilename, count: events.length };
  },
};

registerHandler(Handlers.ALERT_GENERATION, alertGeneration);
