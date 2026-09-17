import { z } from "zod";
import { orgUnitConfigSchema } from "@/services/worker/schemas/orgUnit.ts";

const orgUnitSchema = orgUnitConfigSchema;

const periodSchema = z.object({
  periods: z.array(z.string()).min(1),
});

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function resolveValueDataElementIds(data: {
  valueDataElementIds?: string[];
  valueDataElementId?: string;
}): string[] {
  let ids = data.valueDataElementIds ?? [];
  if (ids.length === 0 && data.valueDataElementId) {
    ids = [data.valueDataElementId];
  }
  return dedupeIds(ids);
}

export const alertGenerationConfigSchema = z
  .object({
    orgUnit: orgUnitSchema,
    period: periodSchema,
    thresholdDataElementId: z.string(),
    valueDataElementIds: z.array(z.string().min(1)).optional(),
    /** Legacy single quantile DE; coerced to valueDataElementIds on parse */
    valueDataElementId: z.string().min(1).optional(),
    aggregationType: z.string().default("SUM"),
  })
  .superRefine((data, ctx) => {
    if (resolveValueDataElementIds(data).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "At least one value data element is required",
        path: ["valueDataElementIds"],
      });
    }
  });

export type AlertGenerationConfig = z.infer<typeof alertGenerationConfigSchema> & {
  valueDataElementIds: string[];
  valueDataElementId?: never;
};

export function parseAlertGenerationConfig(input: unknown): AlertGenerationConfig {
  const parsed = alertGenerationConfigSchema.parse(input);
  const valueDataElementIds = resolveValueDataElementIds(parsed);
  return {
    orgUnit: parsed.orgUnit,
    period: parsed.period,
    thresholdDataElementId: parsed.thresholdDataElementId,
    aggregationType: parsed.aggregationType,
    valueDataElementIds,
  };
}

export const alertGenerationContextSchema = z.object({
  orgUnit: orgUnitSchema,
  period: periodSchema,
});
