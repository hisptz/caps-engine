import { z } from "zod";
import { cronExprSchema } from "@/shared/utils/cron.ts";

export const idParams = z.object({ id: z.uuid("Invalid schedule ID") });

export const updateScheduleBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    cronExpr: cronExprSchema.optional(),
    inputContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type UpdateScheduleBody = z.infer<typeof updateScheduleBody>;
