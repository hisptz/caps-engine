import type { ZodType } from "zod";

/**
 * Field hints: tell the app which DHIS2 picker to show for a config field. A handler's config
 * schema is sent to the app as JSON Schema (GET /handlers), and the app draws a form from it
 * for any handler without a hand-built form. Without a hint, a data element is a plain text
 * box where the user types an ID; with one, it is the data element picker.
 *
 *   const configSchema = z.object({
 *     dataElements: capsField(z.array(z.string()).min(1), "dataElement"),
 *     orgUnit: orgUnitConfigSchema,     // already hinted
 *     period: pullPeriodSchema,         // already hinted
 *   });
 *
 * The hint changes only how the field is drawn; the schema still decides what is valid.
 */
export const CAPS_FIELD_KEY = "x-caps-field";

export const CAPS_FIELDS = {
  /** A DHIS2 data element ID on staging, or a list of them */
  dataElement: "dataElement",
  /** Org units by ID, level or group: `{ ids?, levels?, groups? }` (see `orgUnitConfigSchema`) */
  orgUnits: "orgUnits",
  /** Periods like a pull's: the latest N or a fixed range (see `pullPeriodSchema`) */
  period: "period",
  /** The route code of a connected instance (`caps-src-…`) */
  connectedInstance: "connectedInstance",
  /** DHIS2 user group IDs */
  userGroups: "userGroups",
  /** Climate periods: daily, weekly or monthly, fixed range or latest N (see `climatePeriodSchema`) */
  climatePeriod: "climatePeriod",
  /**
   * The id of an Open Geo Service pipeline; the app can also create and edit it. The value
   * keeps its Open Climate Service era name: deployed caps-app builds match on it.
   */
  geoservicePipeline: "ocsPipeline",
} as const;

export type CapsField = (typeof CAPS_FIELDS)[keyof typeof CAPS_FIELDS];

/** Marks a config field with the picker the app should draw for it. */
export function capsField<T extends ZodType>(schema: T, field: CapsField): T {
  return schema.meta({ [CAPS_FIELD_KEY]: field });
}
