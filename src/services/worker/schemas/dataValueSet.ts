import { z } from "zod";

export const dataValueSchema = z.object({
  dataElement: z.string(),
  period: z.string(),
  orgUnit: z.string(),
  categoryOptionCombo: z.string().optional(),
  attributeOptionCombo: z.string().optional(),
  value: z.string(),
  storedBy: z.string().optional(),
  comment: z.string().optional(),
});

export const dataValueSetSchema = z.object({
  dataSet: z.string().optional(),
  completeDate: z.string().optional(),
  period: z.string().optional(),
  orgUnit: z.string().optional(),
  attributeOptionCombo: z.string().optional(),
  dataValues: z.array(dataValueSchema),
});

export type ParsedDataValueSet = z.infer<typeof dataValueSetSchema>;
