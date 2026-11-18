import { definePlugin } from "@/shared/handlers/plugin.ts";
import { httpDataPullConfigSchema } from "./schemas/config.ts";

/**
 * Example plugin: pulls DHIS2-shaped data values from another system over HTTP, through a
 * connected route, into a file for the DHIS2 Data Upload step. See README.md.
 *
 * Switched on with `CAPS_PLUGINS=http-data-pull`.
 */
export default definePlugin({
  key: "http-data-pull",
  displayName: "HTTP Data Pull",
  description:
    "Pulls data values from your own system over HTTP, through a connected route, into a file for DHIS2 Data Upload",
  tags: ["pull", "plugin"],
  outputs: {
    fields: [
      { key: "count", label: "Values pulled", type: "number" },
      { key: "skipped", label: "Values left out", type: "number" },
    ],
  },
  schemas: {
    config: httpDataPullConfigSchema,
  },
  load: async () => (await import("./index.ts")).httpDataPull,
});
