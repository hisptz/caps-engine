import { z } from "zod";
import { orgUnitConfigSchema } from "@/services/worker/schemas/orgUnit.ts";
import { CALCULATION_METHOD_VALUES } from "@/services/worker/utils/statistics.ts";

// ============================================================
// Config schema
// ============================================================

const CalculationMethodSchema = z.enum(CALCULATION_METHOD_VALUES);

const ThresholdOutputSpecSchema = z.object({
  calculationMethod: CalculationMethodSchema,
  outputDataElementId: z.string(),
});

export const thresholdGenerationConfigSchema = z
  .object({
    orgUnit: orgUnitConfigSchema,
    period: z.object({
      years: z.array(z.string()).min(1),
      periodType: z.enum(["Monthly", "Weekly", "Quarterly", "BiMonthly", "SixMonthly"]),
      yearsToInclude: z.number().int().positive().default(5),
    }),
    dataElementIds: z.array(z.string()).min(1),
    aggregationType: z.string().default("SUM"),
    calculationMethod: CalculationMethodSchema.default("mean + 2SD").optional(),
    outputDataElementId: z.string().optional(),
    outputs: z.array(ThresholdOutputSpecSchema).min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasOutputs = data.outputs !== undefined && data.outputs.length > 0;

    if (hasOutputs) {
      const methods = data.outputs!.map((o) => o.calculationMethod);
      if (new Set(methods).size !== methods.length) {
        ctx.addIssue({
          code: "custom",
          message: "outputs must not contain duplicate calculationMethod values",
          path: ["outputs"],
        });
      }
      return;
    }

    if (!data.outputDataElementId) {
      ctx.addIssue({
        code: "custom",
        message: "outputDataElementId is required when outputs is not provided",
        path: ["outputDataElementId"],
      });
    }
  });

export type ThresholdGenerationConfig = z.infer<typeof thresholdGenerationConfigSchema>;

export type ThresholdOutputSpec = z.infer<typeof ThresholdOutputSpecSchema>;

export const thresholdGenerationContextSchema = z.object({
  orgUnit: orgUnitConfigSchema,
  period: z.object({
    years: z.array(z.string()).min(1),
    periodType: z.enum(["Monthly", "Weekly", "Quarterly", "BiMonthly", "SixMonthly"]),
    yearsToInclude: z.number().int().positive().default(5),
  }),
});
