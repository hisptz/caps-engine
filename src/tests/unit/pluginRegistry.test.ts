import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_PLUGINS } from "@/services/worker/services/handlers/plugins.ts";
import { loadHandlers } from "@/services/worker/utils/loadHandlers.ts";
import {
  definePlugin,
  type HandlerPlugin,
  type RegisteredPlugin,
} from "@/shared/handlers/plugin.ts";
import {
  buildRegistry,
  enabledPluginKeys,
  PLUGIN_REGISTRY,
  STEP_QUEUES,
} from "@/shared/handlers/registry.ts";

const plugin = (key: string, extra: Partial<HandlerPlugin> = {}): HandlerPlugin =>
  definePlugin({
    key,
    displayName: key,
    description: "",
    tags: [],
    outputs: { fields: [] },
    schemas: {},
    load: async () => ({ execute: vi.fn() }),
    ...extra,
  });

describe("plugin registry", () => {
  it("keeps every built-in step on the queue it always had", () => {
    // Saved steps and queued messages name these: none may change. The order is only how the
    // app lists them (BUILT_IN_PLUGINS), so it is not checked here.
    expect([...STEP_QUEUES].sort()).toEqual(
      [
        "step.open-climate-service-sync",
        "step.climate-openeo-create",
        "step.climate-openeo-poll",
        "step.climate-openeo-download",
        "step.prediction-trigger",
        "step.prediction-poll",
        "step.prediction-data-download",
        "step.dhis2-instance-pull",
        "step.dhis2-instance-push",
        "step.dhis2-data-check",
        "step.dhis2-data-upload",
        "step.dhis2-analytics-run",
        "step.threshold-generation",
        "step.alert-generation",
        "step.event-data-upload",
        "step.dhis2-notify",
        "step.ocs-pipeline-run",
      ].sort()
    );
    expect([...PLUGIN_REGISTRY.values()].every((p) => p.builtIn)).toBe(true);
  });

  it("switches on a listed plugin only where CAPS_PLUGINS names it", () => {
    const ewars = plugin("ewars-pull");
    const ukwaba = plugin("ukwaba-pull");

    expect([...buildRegistry([], [ewars, ukwaba], undefined).keys()]).toEqual([]);
    expect([...buildRegistry([], [ewars, ukwaba], " ewars-pull ").keys()]).toEqual(["ewars-pull"]);
    expect([...buildRegistry([], [ewars, ukwaba], "*").keys()]).toEqual([
      "ewars-pull",
      "ukwaba-pull",
    ]);
    expect(buildRegistry([], [ewars], "ewars-pull").get("ewars-pull")).toMatchObject({
      builtIn: false,
      queueName: "step.ewars-pull",
    });
  });

  it("keeps built-ins on whatever CAPS_PLUGINS says", () => {
    expect([...buildRegistry([plugin("dhis2-notify")], [], "").keys()]).toEqual(["dhis2-notify"]);
  });

  it("refuses a broken plugin list at startup", () => {
    expect(() => buildRegistry([plugin("Ewars_Pull")], [], undefined)).toThrow("kebab-case");
    expect(() => buildRegistry([plugin("dhis2-notify")], [plugin("dhis2-notify")], "*")).toThrow(
      'Two plugins use the key "dhis2-notify"'
    );
    expect(() =>
      buildRegistry([plugin("a"), plugin("b", { queueName: "step.a" })], [], undefined)
    ).toThrow("use the same queue step.a");
    expect(() => buildRegistry([], [plugin("ewars-pull")], "ewars-pul")).toThrow(
      "not listed: ewars-pul"
    );
  });

  it("reads CAPS_PLUGINS as a comma-separated list", () => {
    expect(enabledPluginKeys(undefined)).toEqual(new Set());
    expect(enabledPluginKeys("a, b,,")).toEqual(new Set(["a", "b"]));
    expect(enabledPluginKeys("a,*")).toBe("all");
  });

  it("lists each built-in plugin once", () => {
    const keys = BUILT_IN_PLUGINS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("loadHandlers", () => {
  const registered = (p: HandlerPlugin): RegisteredPlugin => ({
    ...p,
    queueName: `step.${p.key}`,
    builtIn: false,
  });

  it("loads the code of every built-in step", async () => {
    const plugins = [...PLUGIN_REGISTRY.values()].map((p) => ({
      ...p,
      key: `loaded-${p.key}`,
    }));
    const loaded = await loadHandlers(plugins);
    expect(loaded).toHaveLength(17);
  });

  it("names the plugin whose code does not load", async () => {
    const broken = registered(
      plugin("broken-load", {
        load: async () => {
          throw new Error("missing module");
        },
      })
    );
    await expect(loadHandlers([broken])).rejects.toThrow(
      'Could not load the code of plugin "broken-load": missing module'
    );

    const empty = registered(
      plugin("empty-load", {
        load: async () => ({}) as never,
      })
    );
    await expect(loadHandlers([empty])).rejects.toThrow(
      'Plugin "empty-load" loaded no handler with an execute function'
    );
  });
});
