import type { HandlerPlugin } from "@/shared/handlers/plugin.ts";

/**
 * Plugins that are not built in, e.g. a country's own data source. Each lives in its own
 * folder here (`src/plugins/<name>/plugin.ts` + `index.ts`, see `src/shared/handlers/plugin.ts`)
 * and is added to this list with one line:
 *
 *   import dataPull from "./dataPull/plugin.ts";
 *   export const PLUGINS: HandlerPlugin[] = [dataPull];
 *
 * A listed plugin is only switched on in a deployment whose `.env` names its key in
 * `CAPS_PLUGINS`, e.g. `CAPS_PLUGINS=data-pull` (comma-separated, or `*` for all). Set it once
 * in `.env`: the compose files already pass it to the API, workers and scheduler.
 */
export const PLUGINS: HandlerPlugin[] = [];
