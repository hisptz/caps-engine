import { registerHandler } from "@/services/worker/types/service.ts";
import type { RegisteredPlugin } from "@/shared/handlers/plugin.ts";
import { PLUGIN_REGISTRY } from "@/shared/handlers/registry.ts";

export async function loadHandlers(
  plugins: Iterable<RegisteredPlugin> = PLUGIN_REGISTRY.values()
): Promise<string[]> {
  const loaded: string[] = [];
  for (const plugin of plugins) {
    let handler;
    try {
      handler = await plugin.load();
    } catch (error) {
      throw new Error(
        `Could not load the code of plugin "${plugin.key}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    if (typeof handler?.execute !== "function") {
      throw new Error(`Plugin "${plugin.key}" loaded no handler with an execute function`);
    }
    registerHandler(plugin.key, handler);
    loaded.push(plugin.key);
  }
  return loaded;
}
