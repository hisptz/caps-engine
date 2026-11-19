import { z } from "zod";
import { pullPeriodSchema } from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";
import { capsField } from "@/shared/handlers/fields.ts";

const uidSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

export const httpDataPullConfigSchema = z.object({
  routeCode: capsField(
    z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
      message: "Pick the connected route that reaches your system",
    }),
    "connectedInstance"
  ).meta({
    title: "System",
    description: "The route on staging that reaches your system and adds its credentials",
  }),
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/]/, "Leave out the leading /, e.g. data-values")
    .meta({
      title: "Endpoint",
      description:
        "Path after the route's URL that returns the data values, e.g. data-values for <route URL>/data-values",
    }),
  period: pullPeriodSchema,
  dataElements: capsField(
    z
      .array(uidSchema)
      .min(1, "Choose at least one data element")
      .refine((ids) => new Set(ids).size === ids.length, "Each data element can be listed once"),
    "dataElement"
  ).meta({
    title: "Data elements",
    description: "Staging data elements to keep; values for anything else are left out",
  }),
  allowEmpty: z.boolean().default(true).meta({
    title: "Allow no data",
    description: "When off, the step fails if your system has no values for these periods",
  }),
});

export type HttpDataPullConfig = z.infer<typeof httpDataPullConfigSchema>;

/**
 * What the endpoint must return: DHIS2's data value shape. A system that answers in another
 * shape needs its own plugin, with its own `toDataValues()` in `index.ts`.
 */
export const remoteDataValueSchema = z.object({
  dataElement: z.string().min(1),
  period: z.string().min(1),
  orgUnit: z.string().min(1),
  categoryOptionCombo: z.string().min(1).optional(),
  attributeOptionCombo: z.string().min(1).optional(),
  value: z.union([z.string(), z.number()]).transform(String),
});

export type RemoteDataValue = z.infer<typeof remoteDataValueSchema>;
