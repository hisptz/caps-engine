import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildMockContext, buildMockTaskHandle } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

const mockGet = vi.fn();
vi.mock("@/shared/clients/dhis.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/clients/dhis.ts")>()),
  createRouteClient: vi.fn(() => ({ get: mockGet })),
}));

import { createRouteClient } from "@/shared/clients/dhis.ts";
import { StepPermanentError } from "@/services/worker/types/service.ts";
import httpDataPullPlugin from "@/plugins/httpDataPull/plugin.ts";
import {
  httpDataPull,
  toDataValues,
  type HttpDataPullOutput,
} from "@/plugins/httpDataPull/index.ts";
import { PLUGINS } from "@/plugins/index.ts";
import { BUILT_IN_PLUGINS } from "@/services/worker/services/handlers/plugins.ts";
import { CAPS_FIELD_KEY } from "@/shared/handlers/fields.ts";
import { buildRegistry } from "@/shared/handlers/registry.ts";

const CASES = "fbfJHSPpUQD";
const DEATHS = "cYeuwXTCPkU";

function config(overrides: Record<string, unknown> = {}) {
  return {
    routeCode: "caps-src-my-system",
    path: "data-values",
    period: { mode: "fixed", periodType: "MONTHLY", start: "202609", end: "202610" },
    dataElements: [CASES],
    ...overrides,
  };
}

function value(dataElement: string, period: string, extra: Record<string, unknown> = {}) {
  return { dataElement, period, orgUnit: "DiszpKrYNg8", value: 5, ...extra };
}

const mockWrite = vi.fn().mockResolvedValue(0);

beforeEach(() => {
  vi.clearAllMocks();
  stubBun({ write: mockWrite });
});

describe("toDataValues", () => {
  const wanted = { dataElements: new Set([CASES]), periods: new Set(["202609"]) };

  it("keeps values asked for, in DHIS2's shape, and counts the rest as skipped", () => {
    const result = toDataValues(
      {
        dataValues: [
          value(CASES, "202609", { categoryOptionCombo: "HllvX50cXC0" }),
          value(DEATHS, "202609"), // not asked for
          value(CASES, "202701"), // another period
          { dataElement: CASES, period: "202609" }, // no org unit or value
        ],
      },
      wanted
    );
    expect(result).toEqual({
      dataValues: [
        {
          dataElement: CASES,
          period: "202609",
          orgUnit: "DiszpKrYNg8",
          categoryOptionCombo: "HllvX50cXC0",
          value: "5",
        },
      ],
      skipped: 3,
    });
  });

  it("refuses an answer that is not a data value set, without retrying", () => {
    expect(() => toDataValues({ rows: [] }, wanted)).toThrow(StepPermanentError);
    expect(() => toDataValues(null, wanted)).toThrow("did not return");
  });
});

describe("http-data-pull handler", () => {
  it("asks the route for the data elements and periods, and writes a file for DHIS2 Data Upload", async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        dataValues: [value(CASES, "202609"), value(CASES, "202610"), value(DEATHS, "202610")],
      },
    });

    const result = (await httpDataPull.execute(
      buildMockContext({ handlerConfig: config() })
    )) as HttpDataPullOutput;

    expect(createRouteClient).toHaveBeenCalledWith("caps-src-my-system");
    const [path, options] = mockGet.mock.calls[0]!;
    expect(path).toBe("data-values");
    const params = options.params as URLSearchParams;
    expect(params.getAll("dataElement")).toEqual([CASES]);
    expect(params.getAll("period")).toEqual(["202609", "202610"]);

    // The next step, DHIS2 Data Upload, reads { filename, allowEmpty }
    expect(result).toMatchObject({
      allowEmpty: true,
      count: 2,
      skipped: 1,
      periods: ["202609", "202610"],
    });
    expect(result.filename).toMatch(/^http-data-pull-.+\.json$/);
    const [writtenPath, content] = mockWrite.mock.calls[0]!;
    expect(String(writtenPath).endsWith(result.filename)).toBe(true);
    expect(JSON.parse(content as string).dataValues).toHaveLength(2);
  });

  it("succeeds with an empty file when there is no data, unless told not to", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { dataValues: [] } });

    const result = (await httpDataPull.execute(
      buildMockContext({ handlerConfig: config() })
    )) as HttpDataPullOutput;
    expect(result).toMatchObject({ count: 0, allowEmpty: true });

    await expect(
      httpDataPull.execute(buildMockContext({ handlerConfig: config({ allowEmpty: false }) }))
    ).rejects.toThrow(StepPermanentError);
  });

  it("names the route when the call fails, and lets the step retry", async () => {
    mockGet.mockRejectedValue(
      new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 502,
      } as never)
    );
    const fetchTask = buildMockTaskHandle();
    const ctx = buildMockContext({
      handlerConfig: config(),
      tasks: { startTask: vi.fn().mockResolvedValue(fetchTask) },
    });

    const error = await httpDataPull.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StepPermanentError);
    expect((error as Error).message).toContain('Route "caps-src-my-system"');
    expect(fetchTask.fail).toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("refuses settings that are not valid, without retrying", async () => {
    await expect(
      httpDataPull.execute(buildMockContext({ handlerConfig: config({ path: "/data-values" }) }))
    ).rejects.toThrow(StepPermanentError);
  });
});

describe("http-data-pull plugin", () => {
  it("is listed, and switched on only where CAPS_PLUGINS names it", () => {
    expect(PLUGINS).toContain(httpDataPullPlugin);
    expect(buildRegistry(BUILT_IN_PLUGINS, PLUGINS, undefined).has("http-data-pull")).toBe(false);
    expect(
      buildRegistry(BUILT_IN_PLUGINS, PLUGINS, "http-data-pull").get("http-data-pull")
    ).toMatchObject({ builtIn: false, queueName: "step.http-data-pull" });
  });

  it("gives the app labels and DHIS2 pickers for its settings", () => {
    const schema = z.toJSONSchema(httpDataPullPlugin.schemas.config!, { io: "input" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.routeCode).toMatchObject({
      title: "System",
      [CAPS_FIELD_KEY]: "connectedInstance",
    });
    expect(schema.properties.dataElements?.[CAPS_FIELD_KEY]).toBe("dataElement");
    expect(schema.properties.period?.[CAPS_FIELD_KEY]).toBe("period");
    expect(schema.properties.path?.title).toBe("Endpoint");
  });

  it("loads its handler", async () => {
    expect(await httpDataPullPlugin.load()).toBe(httpDataPull);
  });
});
