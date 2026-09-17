import type {
  ThresholdGenerationConfig,
  ThresholdOutputSpec,
} from "@/services/worker/services/handlers/thresholdGeneration/schemas/config.ts";
import { isCsumCalculationMethod } from "@/services/worker/utils/statistics.ts";
import {
  getHistoricalWindowPeriods,
  getSubPeriodWindow,
  type ThresholdPeriodType,
} from "@/services/worker/utils/periods.ts";

/** Minimum pooled window values required before emitting a C-SUM-family threshold. */
export const MIN_CSUM_WINDOW_VALUES = 3;

export function resolveOutputSpecs(config: ThresholdGenerationConfig): ThresholdOutputSpec[] {
  if (config.outputs !== undefined && config.outputs.length > 0) {
    return config.outputs;
  }
  return [
    {
      calculationMethod: config.calculationMethod ?? "mean + 2SD",
      outputDataElementId: config.outputDataElementId!,
    },
  ];
}

export function outputSpecsNeedCsumWindow(specs: ThresholdOutputSpec[]): boolean {
  return specs.some((s) => isCsumCalculationMethod(s.calculationMethod));
}

export function collectHistoricalWindowValues(
  orgUnit: string,
  subPeriod: string,
  targetYear: number,
  yearsToInclude: number,
  periodType: ThresholdPeriodType,
  aggregated: Map<string, number>
): number[] {
  const windowValues: number[] = [];
  for (let i = 1; i <= yearsToInclude; i++) {
    const historicalSubPeriod = `${targetYear - i}${subPeriod.slice(4)}`;
    for (const period of getSubPeriodWindow(historicalSubPeriod, periodType)) {
      const value = aggregated.get(`${orgUnit}:${period}`);
      if (value !== undefined) windowValues.push(value);
    }
  }
  return windowValues;
}

export { getHistoricalWindowPeriods };
