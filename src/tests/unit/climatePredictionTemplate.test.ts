import { describe, expect, it } from "vitest";
import {
  buildClimatePredictionPlan,
  checkAgainstSetup,
  checkClimateDatasets,
  climatePredictionParamsSchema,
  stepsFingerprint,
  type TemplatePredictionSetup,
} from "@/shared/templates/climatePrediction.ts";
import { validateHandlerConfig } from "@/shared/handlers/catalog.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";

const RAIN = "RainDataEl1";
const TEMP = "TempDataEl1";
const CASES = "CasesDataE1";

function params(overrides: Record<string, unknown> = {}) {
  return climatePredictionParamsSchema.parse({
    name: "Malawi",
    periodType: "WEEKLY",
    orgUnit: { level: 3 },
    recentPeriods: 12,
    climate: [
      { datasetId: "era5.precip", dataElement: RAIN, aggregation: "sum" },
      { datasetId: "era5.temp", dataElement: TEMP },
    ],
    disease: { source: "staging" },
    ...overrides,
  });
}

const pulled = {
  source: "instance",
  routeCode: "caps-src-hmis",
  items: [{ from: CASES, fromType: "DATA_ELEMENT" }],
};

const setup: TemplatePredictionSetup = {
  id: 7,
  name: "EWARS weekly",
  backtestId: 3,
  periodType: "week",
  orgUnits: ["OrgUnitAa01", "OrgUnitBb02"],
  covariateSources: [
    { covariate: "rainfall", dataElementId: RAIN },
    { covariate: "mean_temperature", dataElementId: TEMP },
    { covariate: "disease_cases", dataElementId: CASES },
  ],
};

describe("climatePredictionParamsSchema", () => {
  it("needs org units unless a prediction setup provides them", () => {
    const result = climatePredictionParamsSchema.safeParse({
      ...params(),
      orgUnit: undefined,
    });
    expect(result.success).toBe(false);
    expect(
      climatePredictionParamsSchema.safeParse({
        ...params(),
        orgUnit: undefined,
        prediction: { predictionSetupId: 7 },
      }).success
    ).toBe(true);
  });

  it("pulls either mapped data elements or, for older workflows, listed items", () => {
    const mapped = { source: "instance", routeCode: "caps-src-hmis", mapped: [CASES] };
    expect(climatePredictionParamsSchema.safeParse({ ...params(), disease: mapped }).success).toBe(
      true
    );
    expect(climatePredictionParamsSchema.safeParse({ ...params(), disease: pulled }).success).toBe(
      true
    );
    expect(
      climatePredictionParamsSchema.safeParse({
        ...params(),
        disease: { source: "instance", routeCode: "caps-src-hmis" },
      }).success
    ).toBe(false);
  });

  it("limits how many months a run refreshes", () => {
    const result = climatePredictionParamsSchema.safeParse({
      ...params(),
      periodType: "MONTHLY",
      recentPeriods: 40,
    });
    expect(result.success).toBe(false);
  });
});

describe("buildClimatePredictionPlan", () => {
  it("without a setup: climate data, then analytics only, joined by a connector", () => {
    const plan = buildClimatePredictionPlan(params(), null);

    expect(plan.pipelines.map((p) => p.role)).toEqual(["climate", "prediction"]);
    expect(plan.pipelines[0]!.steps[0]!.handlerConfig).toEqual({
      datasetIds: ["era5.precip", "era5.temp"],
    });
    expect(plan.pipelines[0]!.steps.map((s) => s.handlerKey)).toEqual([
      Handlers.OPEN_CLIMATE_SERVICE_SYNC,
      Handlers.CLIMATE_OPENEO_CREATE,
      Handlers.CLIMATE_OPENEO_POLL,
      Handlers.CLIMATE_OPENEO_DOWNLOAD,
      Handlers.DHIS2_DATA_UPLOAD,
      Handlers.CLIMATE_OPENEO_CREATE,
      Handlers.CLIMATE_OPENEO_POLL,
      Handlers.CLIMATE_OPENEO_DOWNLOAD,
      Handlers.DHIS2_DATA_UPLOAD,
    ]);
    expect(plan.pipelines[0]!.steps[1]!.handlerConfig).toMatchObject({
      datasetId: "era5.precip",
      variable: { dataElement: RAIN },
      aggregation: { method: "sum" },
      period: { mode: "rolling", periodType: "weekly", count: 12 },
      orgUnit: { levels: ["3"] },
    });
    expect(plan.pipelines[1]!.steps.map((s) => s.handlerKey)).toEqual([
      Handlers.DHIS2_ANALYTICS_RUN,
    ]);
    expect(plan.join).toEqual({ kind: "connector", source: "climate", target: "prediction" });
  });

  it("with a pull and a setup: both data pipelines merge into the prediction", () => {
    const plan = buildClimatePredictionPlan(
      params({
        disease: pulled,
        prediction: { predictionSetupId: 7, notify: { userGroups: ["ModellersGr"] } },
      }),
      setup
    );

    expect(plan.pipelines.map((p) => p.name)).toEqual([
      "Malawi · Climate data",
      "Malawi · Disease data",
      "Malawi · Prediction",
    ]);
    // The setup's org units replace the chosen ones everywhere
    expect(plan.pipelines[0]!.steps[1]!.handlerConfig.orgUnit).toEqual({ ids: setup.orgUnits });
    expect(plan.pipelines[1]!.steps[0]!.handlerConfig).toMatchObject({
      routeCode: "caps-src-hmis",
      orgUnit: { ids: setup.orgUnits },
      period: { mode: "relative", periodType: "WEEKLY", count: 12, offset: 1 },
    });
    expect(plan.pipelines[2]!.steps.map((s) => s.handlerKey)).toEqual([
      Handlers.DHIS2_ANALYTICS_RUN,
      Handlers.PREDICTION_TRIGGER,
      Handlers.PREDICTION_POLL,
      Handlers.DHIS2_NOTIFY,
    ]);
    expect(plan.pipelines[2]!.steps[1]!.handlerConfig).toMatchObject({
      predictionSetupId: 7,
      backtestId: 3,
      period: { periodOffset: 1, numberOfPeriodsToGenerate: 3 },
    });
    expect(plan.join).toEqual({
      kind: "merge",
      sources: ["climate", "disease"],
      target: "prediction",
    });
  });

  it("leaves out the message when nobody is to be told", () => {
    const plan = buildClimatePredictionPlan(
      params({ prediction: { predictionSetupId: 7 } }),
      setup
    );
    expect(plan.pipelines.at(-1)!.steps.map((s) => s.handlerKey)).not.toContain(
      Handlers.DHIS2_NOTIFY
    );
  });

  it("generates step settings every handler accepts", () => {
    const plan = buildClimatePredictionPlan(
      params({
        disease: pulled,
        prediction: { predictionSetupId: 7, notify: { users: ["ModellerUs1"] } },
      }),
      setup
    );
    for (const step of plan.pipelines.flatMap((p) => p.steps)) {
      expect(validateHandlerConfig(step.handlerKey, step.handlerConfig)).toEqual({
        success: true,
      });
    }
  });
});

describe("disease pull from instance mappings", () => {
  it("gives the pull step the mapped data elements, not items", () => {
    const plan = buildClimatePredictionPlan(
      params({ disease: { source: "instance", routeCode: "caps-src-hmis", mapped: [CASES] } }),
      null
    );
    const config = plan.pipelines[1]!.steps[0]!.handlerConfig;
    expect(config).toMatchObject({ routeCode: "caps-src-hmis", mapped: [CASES] });
    expect(config).not.toHaveProperty("items");
  });
});

describe("checkAgainstSetup", () => {
  it("refuses a period type the setup was not evaluated on", () => {
    const { errors } = checkAgainstSetup(
      params({ periodType: "MONTHLY", recentPeriods: 3 }),
      setup
    );
    expect(errors.map((e) => e.path)).toEqual(["periodType"]);
  });

  it("warns about inputs nothing fetches and climate the setup does not use", () => {
    const { errors, warnings } = checkAgainstSetup(
      params({
        climate: [
          { datasetId: "era5.precip", dataElement: RAIN },
          { datasetId: "era5.humidity", dataElement: "HumidDataE1" },
        ],
      }),
      setup
    );
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      `"mean_temperature" (${TEMP}) is not fetched by this workflow; it must already be in staging`,
      `"disease_cases" (${CASES}) is not fetched by this workflow; it must already be in staging`,
      "era5.humidity goes into HumidDataE1, which the prediction setup does not use",
    ]);
  });

  it("counts pulled data as supplied", () => {
    const { warnings } = checkAgainstSetup(params({ disease: pulled }), setup);
    expect(warnings).toEqual([]);
  });
});

describe("stepsFingerprint", () => {
  it("ignores key order, as the database may reorder JSON keys", () => {
    const a = [{ name: "s", handlerKey: "h", handlerConfig: { a: 1, b: { c: 2, d: 3 } } }];
    const b = [{ name: "s", handlerKey: "h", handlerConfig: { b: { d: 3, c: 2 }, a: 1 } }];
    expect(stepsFingerprint(a)).toBe(stepsFingerprint(b));
    expect(stepsFingerprint(a)).not.toBe(
      stepsFingerprint([{ ...a[0]!, handlerConfig: { a: 2, b: { c: 2, d: 3 } } }])
    );
  });
});

describe("checkClimateDatasets", () => {
  it("needs a known time series at least as frequent as the workflow's periods", () => {
    const issues = checkClimateDatasets(
      params({
        climate: [
          { datasetId: "daily", dataElement: RAIN },
          { datasetId: "monthly", dataElement: TEMP },
          { datasetId: "normals", dataElement: "NormalData1" },
          { datasetId: "missing", dataElement: "MissingDat1" },
        ],
      }),
      [
        { id: "daily", periodType: "daily" },
        { id: "monthly", periodType: "monthly" },
        { id: "normals", periodType: "climatology" },
      ]
    );
    expect(issues).toEqual([
      {
        path: "climate.1.datasetId",
        message: '"monthly" is monthly; it cannot give weekly values',
      },
      { path: "climate.2.datasetId", message: '"normals" is not a time series (climatology)' },
      {
        path: "climate.3.datasetId",
        message:
          'Open Climate Service has no dataset "missing"; ingest it on the Climate data page first',
      },
    ]);
  });
});
