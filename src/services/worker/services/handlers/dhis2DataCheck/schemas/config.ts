import { z } from "zod";
import { orgUnitConfigSchema } from "@/services/worker/schemas/orgUnit.ts";
import { pullPeriodSchema } from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";

const uidSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

/**
 * What to look for: these data elements, for these org units and periods. The periods use the
 * same settings as a pull (fixed range, or e.g. "the last 1 month").
 */
export const dhis2DataCheckConfigSchema = z.object({
  dataElements: z
    .array(uidSchema)
    .min(1, "Choose at least one data element")
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Each data element can be listed once"),
  orgUnit: orgUnitConfigSchema,
  period: pullPeriodSchema,
  /** Org units per request to DHIS2 */
  chunkOrgUnits: z.number().int().min(1).max(500).default(50),
});

export type Dhis2DataCheckConfig = z.infer<typeof dhis2DataCheckConfigSchema>;
