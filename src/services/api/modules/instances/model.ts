import { z } from "zod";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";
import { pullItemTypeSchema } from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";

const uidSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

export const routeCodeParams = z.object({
  code: z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
    message: "Connected instance codes start with caps-src-",
  }),
});

export const instanceMappingSchema = z.object({
  remoteItem: uidSchema,
  remoteItemType: pullItemTypeSchema,
  stagingDataElement: uidSchema,
  /** PULL: instance → staging. PUSH: staging → instance. */
  direction: z.enum(["PULL", "PUSH"]),
});

/** Replaces the instance's settings and its whole list of mappings. */
export const putInstanceBody = z
  .object({
    orgUnitMatch: z.enum(["id", "code"]),
    mappings: z.array(instanceMappingSchema).max(2000),
  })
  .strict();

export type PutInstanceBody = z.infer<typeof putInstanceBody>;
