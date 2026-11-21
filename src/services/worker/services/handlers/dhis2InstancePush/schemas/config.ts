import { z } from "zod";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";
import { capsField } from "@/shared/handlers/fields.ts";
import {
  hasOrgUnitSelection,
  optionalOrgUnitConfigSchema,
  type OrgUnitConfigInput,
} from "@/services/worker/schemas/orgUnit.ts";
import { dataValueImportStrategySchema } from "@/services/worker/services/handlers/dhis2DataUpload/schemas/config.ts";
import {
  fixedPullPeriodSchema,
  relativePullPeriodSchema,
} from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";

const uidSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

export const pushItemSchema = z.object({
  /** Data element on staging to read values from. */
  from: uidSchema,
  /** Data element on the target instance; the same ID as `from` when left out. */
  into: uidSchema.optional(),
});

export type PushItem = z.infer<typeof pushItemSchema>;

export function pushItemTarget(item: PushItem): string {
  return item.into ?? item.from;
}

/**
 * Values stored or changed on staging in the last `days` days, whatever their period. Suits
 * schedules: predictions and thresholds are often for future periods, which a look-back range
 * of periods would miss.
 */
export const updatedPushPeriodSchema = z.object({
  mode: z.literal("updated"),
  days: z.number().int().min(1).max(366),
});

/** Which staging values to read: recently updated ones, or a fixed or relative range of periods. */
export const pushPeriodSchema = z.discriminatedUnion("mode", [
  updatedPushPeriodSchema,
  fixedPullPeriodSchema,
  relativePullPeriodSchema,
]);

export type PushPeriod = z.infer<typeof pushPeriodSchema>;

/**
 * Where the values to push are read from:
 * - raw: data values on staging as entered, at exactly the selected org units
 *   (`GET /dataValueSets`);
 * - analytics: totals on staging rolled up to the selected org units
 *   (`GET /analytics/dataValueSet`), as of staging's last analytics run. Periods only:
 *   analytics can't filter by last update;
 * - previous: the data value set file the previous step wrote (e.g. dhis2-instance-pull), in
 *   staging IDs. Nothing is read from or stored on staging's data; staging's data elements and
 *   org units are only used to map the values to the target. The file sets the periods.
 */
export const pushSourceSchema = z.enum(["raw", "analytics", "previous"]);

export type PushSource = z.infer<typeof pushSourceSchema>;

const pushItemsSchema = z
  .array(pushItemSchema)
  .min(1)
  .superRefine((items, ctx) => {
    const seenFrom = new Set<string>();
    const seenInto = new Set<string>();
    items.forEach((item, index) => {
      if (seenFrom.has(item.from)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "from"],
          message: "Each staging data element may only be listed once",
        });
      }
      seenFrom.add(item.from);
      const target = pushItemTarget(item);
      if (seenInto.has(target)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "into"],
          message: "Two items write into the same target data element",
        });
      }
      seenInto.add(target);
    });
  });

const pushConfigFields = {
  routeCode: capsField(
    z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
      message: "Pick a connected instance (route code starting with caps-src-)",
    }),
    "connectedInstance"
  ),
  items: pushItemsSchema.optional(),
  /** Staging data elements to push, as the instance's mappings say where each goes. */
  mapped: z
    .array(uidSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Each data element may only be listed once")
    .optional(),
  source: pushSourceSchema.default("raw"),
  /**
   * Staging org units whose values are sent. Required when reading staging; with the previous
   * step's file it narrows the file's org units, and every org unit in the file is sent when
   * left out or empty.
   */
  orgUnit: optionalOrgUnitConfigSchema.optional(),
  orgUnitMatch: z.enum(["id", "code"]).default("id"),
  /** Which staging values to read. Required when reading staging; the file sets its own. */
  period: pushPeriodSchema.optional(),
  importStrategy: dataValueImportStrategySchema.default("CREATE_AND_UPDATE"),
  chunk: z
    .object({
      /** Org units per read from staging. */
      orgUnits: z.number().int().min(1).max(500).default(50),
      /** Periods per analytics read from staging (analytics source only). */
      periods: z.number().int().min(1).max(60).default(12),
      /** Data values per request to the target; each must finish within the route's timeout. */
      values: z.number().int().min(100).max(10_000).default(2_000),
    })
    .default({ orgUnits: 50, periods: 12, values: 2_000 }),
};

function checkPushConfig(
  config: { source: PushSource; period?: PushPeriod; orgUnit?: OrgUnitConfigInput },
  ctx: z.RefinementCtx
) {
  if (config.source !== "previous") {
    if (!hasOrgUnitSelection(config.orgUnit)) {
      ctx.addIssue({
        code: "custom",
        path: ["orgUnit"],
        message: "Pick the staging org units whose values are pushed",
      });
    }
    if (config.period === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["period"],
        message: "Pick which staging values to read: recently updated ones or a range of periods",
      });
    }
  }
  if (config.source === "analytics" && config.period?.mode === "updated") {
    ctx.addIssue({
      code: "custom",
      path: ["period", "mode"],
      message:
        "Analytics can't be read by last update; pick latest periods or a fixed range, or read raw data",
    });
  }
}

/**
 * A step either lists its items (older steps), or names `mapped` staging data elements and the
 * engine fills in `items` and `orgUnitMatch` from the instance before the step runs
 * (`resolveInstanceMappings`).
 */
export const dhis2InstancePushConfigSchema = z
  .object(pushConfigFields)
  .superRefine((config, ctx) => {
    checkPushConfig(config, ctx);
    if ((config.items === undefined) === (config.mapped === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["mapped"],
        message: "Pick the mapped data elements to push",
      });
    }
  });

/** What the handler runs: items are always there by then. */
export const resolvedPushConfigSchema = z
  .object({ ...pushConfigFields, items: pushItemsSchema })
  .superRefine(checkPushConfig);

export type Dhis2InstancePushConfig = z.infer<typeof resolvedPushConfigSchema>;

/**
 * A run may replace the period, e.g. with a fixed range to backfill history. Without one the
 * step's own period is used, so schedules follow later edits to the step.
 */
export const dhis2InstancePushContextSchema = z.object({
  period: pushPeriodSchema.optional(),
});
