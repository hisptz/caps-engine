import { PLUGINS } from "@/plugins/index.ts";
import { BUILT_IN_PLUGINS } from "@/services/worker/services/handlers/plugins.ts";
import {
  PLUGIN_KEY_PATTERN,
  type HandlerPlugin,
  type RegisteredPlugin,
} from "@/shared/handlers/plugin.ts";

export function enabledPluginKeys(setting: string | undefined): Set<string> | "all" {
  const keys = (setting ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.includes("*") ? "all" : new Set(keys);
}

export function buildRegistry(
  builtIn: HandlerPlugin[],
  extra: HandlerPlugin[],
  setting: string | undefined
): Map<string, RegisteredPlugin> {
  const enabled = enabledPluginKeys(setting);
  const registry = new Map<string, RegisteredPlugin>();
  const queues = new Map<string, string>();

  const add = (plugin: HandlerPlugin, isBuiltIn: boolean) => {
    if (!PLUGIN_KEY_PATTERN.test(plugin.key)) {
      throw new Error(`Plugin key "${plugin.key}" must be kebab-case, e.g. "ewars-pull"`);
    }
    if (registry.has(plugin.key)) {
      throw new Error(`Two plugins use the key "${plugin.key}"`);
    }
    const queueName = plugin.queueName ?? `step.${plugin.key}`;
    const queueOwner = queues.get(queueName);
    if (queueOwner) {
      throw new Error(
        `Plugins "${queueOwner}" and "${plugin.key}" use the same queue ${queueName}`
      );
    }
    queues.set(queueName, plugin.key);
    registry.set(plugin.key, { ...plugin, queueName, builtIn: isBuiltIn });
  };

  for (const plugin of builtIn) {
    add(plugin, true);
  }
  for (const plugin of extra) {
    if (enabled === "all" || enabled.has(plugin.key)) {
      add(plugin, false);
    }
  }

  if (enabled !== "all") {
    const unknown = [...enabled].filter(
      (key) => !extra.some((plugin) => plugin.key === key) && !registry.has(key)
    );
    if (unknown.length > 0) {
      throw new Error(`CAPS_PLUGINS names plugins that are not listed: ${unknown.join(", ")}`);
    }
  }

  return registry;
}

/** Every step this deployment can run, keyed by handler key. */
export const PLUGIN_REGISTRY: ReadonlyMap<string, RegisteredPlugin> = buildRegistry(
  BUILT_IN_PLUGINS,
  PLUGINS,
  process.env.CAPS_PLUGINS
);

export function getPlugin(key: string): RegisteredPlugin | undefined {
  return PLUGIN_REGISTRY.get(key);
}

export const STEP_QUEUES: string[] = [...PLUGIN_REGISTRY.values()].map((p) => p.queueName);
