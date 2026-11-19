import { z } from "zod";
import { capsField } from "@/shared/handlers/fields.ts";

const orgUnitConfigBaseSchema = z.object({
  ids: z.array(z.string()).optional(),
  levels: z.array(z.number().int().positive()).optional(),
  groups: z.array(z.string()).optional(),
});

export type OrgUnitConfigInput = z.infer<typeof orgUnitConfigBaseSchema>;

export const orgUnitConfigSchema = capsField(
  orgUnitConfigBaseSchema.superRefine((ou, ctx) => {
    const hasIds = (ou.ids?.length ?? 0) > 0;
    const hasLevels = (ou.levels?.length ?? 0) > 0;
    const hasGroups = (ou.groups?.length ?? 0) > 0;
    if (!hasIds && !hasLevels && !hasGroups) {
      ctx.addIssue({
        code: "custom",
        message:
          "orgUnit: at least one of ids, levels, or groups must be provided with at least one value",
      });
    }
  }),
  "orgUnits"
);
