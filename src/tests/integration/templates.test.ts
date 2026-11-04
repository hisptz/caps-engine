import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@db/client";
import { ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import type { TemplatePredictionSetup } from "@/shared/templates/climatePrediction.ts";
import { clearExecutionData, createTestPrisma } from "../utils/helpers.ts";

// The services read the API's shared client; point it at the test database
const db = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@/services/api/utils/db.ts", () => ({
  get apiDb() {
    return db.client;
  },
}));

const { TemplateService } = await import("@/services/api/modules/templates/service.ts");

// ============================================================
// Workflows from the Climate → Prediction template, against a real database: created with
// their pipelines and join, updated in place by "Edit setup", backfilled over a fixed range.
// ============================================================

const RAIN = "RainDataEl1";
const CASES = "CasesDataE1";

const setup: TemplatePredictionSetup = {
  id: 7,
  name: "EWARS weekly",
  backtestId: 3,
  periodType: "week",
  orgUnits: ["OrgUnitAa01"],
  covariateSources: [
    { covariate: "rainfall", dataElementId: RAIN },
    { covariate: "disease_cases", dataElementId: CASES },
  ],
};

const lookups = {
  predictionSetup: vi.fn(async (id: number) => ({ setup: id === setup.id ? setup : null })),
  missingDataElements: vi.fn<(ids: string[]) => Promise<string[] | null>>(async () => []),
  routeReachable: vi.fn(async () => true),
  pulledFromInstance: vi.fn(async () => new Set<string>()),
  climateDatasets: vi.fn<() => Promise<{ id: string; periodType: string | null }[] | null>>(
    async () => [{ id: "era5.precip", periodType: "daily" }]
  ),
};

let prisma: PrismaClient;
let service: InstanceType<typeof TemplateService>;

beforeAll(() => {
  prisma = createTestPrisma();
  db.client = prisma;
  service = new TemplateService(lookups);
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await clearExecutionData(prisma);
  vi.clearAllMocks();
});

function params(overrides: Record<string, unknown> = {}) {
  return {
    name: `Malawi ${Date.now()}`,
    periodType: "WEEKLY",
    orgUnit: { level: 3 },
    recentPeriods: 12,
    climate: [{ datasetId: "era5.precip", dataElement: RAIN, aggregation: "sum" }],
    disease: { source: "staging" },
    ...overrides,
  };
}

const pulled = {
  source: "instance",
  routeCode: "caps-src-hmis",
  items: [{ from: CASES, fromType: "DATA_ELEMENT" }],
};

async function expectApiError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

describe("TemplateService.preview", () => {
  it("lists every problem instead of stopping at the first", async () => {
    lookups.missingDataElements.mockResolvedValueOnce([RAIN]);
    lookups.routeReachable.mockResolvedValueOnce(false);

    const preview = await service.preview("climate-prediction", params({ disease: pulled }));

    expect(preview.errors).toEqual([
      { path: "climate.0.dataElement", message: `Data element ${RAIN} does not exist in staging` },
      {
        path: "disease.routeCode",
        message: "The source instance could not be reached through its route",
      },
    ]);
    expect(preview.plan?.pipelines).toHaveLength(3);
  });

  it("reports a prediction setup CHAP does not have", async () => {
    const preview = await service.preview(
      "climate-prediction",
      params({ prediction: { predictionSetupId: 99 } })
    );
    expect(preview.errors).toEqual([
      { path: "prediction.predictionSetupId", message: "Prediction setup not found in CHAP" },
    ]);
    expect(preview.plan).toBeNull();
  });
});

describe("TemplateService.create", () => {
  it("creates the workflow, its pipelines in order, and the merge joining them", async () => {
    const { workflow } = await service.create("climate-prediction", {
      params: params({ disease: pulled, prediction: { predictionSetupId: 7 } }),
    });

    expect(workflow.template).toBe("climate-prediction");
    expect(workflow.pipelines.map((p) => p.name.split(" · ")[1])).toEqual([
      "Climate data",
      "Disease data",
      "Prediction",
    ]);
    const prediction = workflow.pipelines.find((p) => p.name.endsWith("Prediction"))!;
    expect(prediction.steps.map((s) => s.handlerKey)).toEqual([
      Handlers.DHIS2_ANALYTICS_RUN,
      Handlers.PREDICTION_TRIGGER,
      Handlers.PREDICTION_POLL,
    ]);
    expect(workflow.merges).toHaveLength(1);
    expect(workflow.merges[0]!.targetPipelineId).toBe(prediction.id);
    // Climate and disease data start together
    expect(workflow.entryPipelineIds).toHaveLength(2);
    expect(workflow.entryPipelineIds).not.toContain(prediction.id);
  });

  it("refuses invalid parameters with every problem in the details", async () => {
    const err = await expectApiError(
      service.create("climate-prediction", {
        params: params({ periodType: "MONTHLY", prediction: { predictionSetupId: 7 } }),
      }),
      ApiErrorCode.TEMPLATE_INVALID
    );
    expect(err.details).toMatchObject({ errors: [{ path: "periodType" }] });
    expect(await prisma.workflow.count()).toBe(0);
  });

  it("backfills once over the range, with each data step on the fixed period", async () => {
    const { workflow, backfillRun } = await service.create("climate-prediction", {
      params: params(),
      backfill: { mode: "fixed", periodType: "WEEKLY", start: "2020W1", end: "2026W43" },
    });

    expect(backfillRun?.started).toHaveLength(1);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: backfillRun!.workflowRunId },
    });
    expect(run.period).toEqual({ periodType: "WEEKLY", start: "2020W1", end: "2026W43" });

    const execution = await prisma.pipelineExecution.findUniqueOrThrow({
      where: { id: backfillRun!.started[0]!.executionId },
    });
    const climate = workflow.pipelines.find((p) => p.name.endsWith("Climate data"))!;
    const requestStep = climate.steps[1]!;
    expect(execution.context).toMatchObject({
      steps: {
        [requestStep.id]: {
          period: { mode: "fixed", periodType: "weekly", id: "2020W1", endId: "2026W43" },
        },
      },
    });
  });
});

describe("TemplateService.updateSetup", () => {
  it("adds the prediction to the same pipeline once a setup is chosen", async () => {
    const first = params();
    const { workflow } = await service.create("climate-prediction", { params: first });
    const predictionId = workflow.pipelines.find((p) => p.name.endsWith("Prediction"))!.id;
    const analyticsStepId = workflow.pipelines.find((p) => p.id === predictionId)!.steps[0]!.id;

    const updated = await service.updateSetup(workflow.id, {
      params: { ...first, prediction: { predictionSetupId: 7 } },
      force: false,
    });

    const prediction = updated.pipelines.find((p) => p.id === predictionId)!;
    expect(prediction.steps.map((s) => s.handlerKey)).toEqual([
      Handlers.DHIS2_ANALYTICS_RUN,
      Handlers.PREDICTION_TRIGGER,
      Handlers.PREDICTION_POLL,
    ]);
    // The step that stays keeps its id, and so its run history
    expect(prediction.steps[0]!.id).toBe(analyticsStepId);
    // Org units now come from the setup
    const climate = updated.pipelines.find((p) => p.name.endsWith("Climate data"))!;
    expect(climate.steps[1]!.handlerConfig).toMatchObject({ orgUnit: { ids: setup.orgUnits } });
  });

  it("switches the join when disease data starts being pulled, and back", async () => {
    const first = params();
    const { workflow } = await service.create("climate-prediction", { params: first });
    expect(workflow.connectors).toHaveLength(1);

    const pulling = await service.updateSetup(workflow.id, {
      params: { ...first, disease: pulled },
      force: false,
    });
    expect(pulling.pipelines).toHaveLength(3);
    expect(pulling.connectors).toHaveLength(0);
    expect(pulling.merges).toHaveLength(1);

    const back = await service.updateSetup(workflow.id, { params: first, force: false });
    expect(back.pipelines).toHaveLength(2);
    expect(back.merges).toHaveLength(0);
    expect(back.connectors).toHaveLength(1);
    // The disease pipeline never ran, so it is gone rather than kept switched off
    expect(await prisma.pipeline.count()).toBe(2);
  });

  it("shows the name and schedule the workflow has now, not the ones it was made with", async () => {
    const { workflow } = await service.create("climate-prediction", {
      params: params({ cronExpr: "0 6 * * 1" }),
    });
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { name: `${workflow.name} renamed`, cronExpr: null },
    });

    const setup = await service.getSetup(workflow.id);
    expect(setup.params).toMatchObject({ name: `${workflow.name} renamed`, cronExpr: null });
  });

  it("refuses to overwrite steps changed by hand unless forced", async () => {
    const first = params();
    const { workflow } = await service.create("climate-prediction", { params: first });
    const climate = workflow.pipelines.find((p) => p.name.endsWith("Climate data"))!;
    await prisma.pipelineStep.update({
      where: { id: climate.steps[4]!.id },
      data: { handlerConfig: { importStrategy: "CREATE" } },
    });

    expect((await service.getSetup(workflow.id)).editedPipelines).toEqual([
      { role: "climate", id: climate.id, name: climate.name },
    ]);
    const next = { ...first, recentPeriods: 4 };
    await expectApiError(
      service.updateSetup(workflow.id, { params: next, force: false }),
      ApiErrorCode.TEMPLATE_EDITED
    );

    await service.updateSetup(workflow.id, { params: next, force: true });
    expect((await service.getSetup(workflow.id)).editedPipelines).toEqual([]);
  });
});
