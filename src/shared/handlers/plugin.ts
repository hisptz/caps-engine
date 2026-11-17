import type { ZodType } from "zod";
import type { StepHandler } from "@/services/worker/types/service.ts";

export type HandlerOutputField = {
  key: string;
  label: string;
  type: "number";
};

export type HandlerOutputs = { fields: HandlerOutputField[] } | { passThrough: true };

/**
 * A handler plugin: one kind of pipeline step. The definition (everything but `load`) is read
 * by the API to list the step and check its config, and is sent to the app on GET /handlers,
 * where the config form is drawn from `schemas.config`. Only the worker calls `load`, so the
 * code that runs the step, and what it imports, never runs in the API.
 *
 * A plugin lives in its own folder with two files:
 *
 *   plugin.ts   export default definePlugin({ key, displayName, …, load: async () =>
 *                 (await import("./index.ts")).myHandler })
 *   index.ts    export const myHandler: StepHandler = { async execute(ctx) { … } }
 *
 * Built-in plugins are listed in `src/services/worker/services/handlers/plugins.ts`, others in
 * `src/plugins/index.ts`.
 */
export type HandlerPlugin = {
  /** Kebab-case and unique, e.g. `data-pull`. */
  key: string;
  displayName: string;
  description: string;
  tags: string[];
  /** Kept in step with what `execute` returns; the app offers these in connector conditions */
  outputs: HandlerOutputs;
  schemas: {
    /**
     * The step's settings. Mark DHIS2 fields with `capsField()` (`./fields.ts`) so the app
     * shows its pickers for them.
     */
    config?: ZodType;
    /** Settings a run or schedule may override */
    context?: ZodType;
  };
  /** Context keys that replace the config value whole rather than merging into it */
  contextReplaces?: string[];
  /** RabbitMQ queue the step's jobs go to. Defaults to `step.<key>`. */
  queueName?: string;
  /** Loads the code that runs the step (worker only). */
  load: () => Promise<StepHandler>;
};

/** A plugin with its defaults filled in, as the registry holds it. */
export type RegisteredPlugin = HandlerPlugin & { queueName: string; builtIn: boolean };

export const PLUGIN_KEY_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Declares a plugin. An identity function: it only gives the definition its type. */
export function definePlugin(plugin: HandlerPlugin): HandlerPlugin {
  return plugin;
}
