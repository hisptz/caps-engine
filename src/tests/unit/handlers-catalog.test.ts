import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  formatHandlerConfigIssues,
  getHandlerDescriptor,
  isKnownHandlerKey,
  listHandlerDescriptors,
  validateHandlerConfig,
} from "@/shared/handlers/catalog.ts";
import { climateOpenEoConfigSchema } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import { predictionTriggerConfigSchema } from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import { thresholdGenerationConfigSchema } from "@/services/worker/services/handlers/thresholdGeneration/schemas/config.ts";
import { alertGenerationConfigSchema } from "@/services/worker/services/handlers/alertGeneration/schemas/config.ts";
import { predictionDataDownloadConfigSchema } from "@/services/worker/services/handlers/predictionDataDownload/schemas/config.ts";
import { dhis2AnalyticsRunConfigSchema } from "@/services/worker/services/handlers/dhis2AnalyticsRun/schemas/config.ts";

describe("handler catalog", () => {
  it("lists all registered handlers with display metadata", () => {
    const handlers = listHandlerDescriptors();
    expect(handlers).toHaveLength(11);
    const keys = handlers.map((h) => h.key).sort();
    expect(keys).toEqual(
      [
        "alert-generation",
        "climate-openeo-create",
        "climate-openeo-download",
        "climate-openeo-poll",
        "dhis2-analytics-run",
        "dhis2-data-upload",
        "event-data-upload",
        "prediction-data-download",
        "prediction-poll",
        "prediction-trigger",
        "threshold-generation",
      ].sort()
    );
    const climateCreate = handlers.find((h) => h.key === "climate-openeo-create");
    expect(climateCreate?.displayName).toBe("Open Climate Service Create");
    expect(climateCreate?.queueName).toBe("step.climate-openeo-create");
    expect(climateCreate?.schemas?.config).toBeDefined();
    expect(climateCreate?.schemas?.context).toBeDefined();
    const climatePoll = handlers.find((h) => h.key === "climate-openeo-poll");
    expect(climatePoll?.displayName).toBe("Open Climate Service Poll");
    expect(climatePoll?.queueName).toBe("step.climate-openeo-poll");
    const climateDownload = handlers.find((h) => h.key === "climate-openeo-download");
    expect(climateDownload?.displayName).toBe("Open Climate Service Download");
    expect(climateDownload?.queueName).toBe("step.climate-openeo-download");
  });

  it("isKnownHandlerKey accepts registry keys only", () => {
    expect(isKnownHandlerKey("climate-openeo-create")).toBe(true);
    expect(isKnownHandlerKey("climate-openeo-poll")).toBe(true);
    expect(isKnownHandlerKey("climate-openeo-download")).toBe(true);
    expect(isKnownHandlerKey("climate-data-trigger")).toBe(false);
  });

  it("getHandlerDescriptor returns a single entry", () => {
    const d = getHandlerDescriptor("prediction-data-download");
    expect(d?.displayName).toBe("Prediction Data Download");
    expect(d?.schemas?.config).toBeDefined();
  });

  it("validateHandlerConfig rejects missing config when schema exists", () => {
    const result = validateHandlerConfig("prediction-trigger", undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatHandlerConfigIssues(result.issues).error).toBe("Invalid handler configuration");
    }
  });

  it("validateHandlerConfig accepts handlers without config schema", () => {
    expect(validateHandlerConfig("prediction-poll", undefined).success).toBe(true);
    expect(validateHandlerConfig("prediction-poll", {}).success).toBe(true);
  });
});

describe("handler config JSON Schema round-trip", () => {
  const predictionTriggerValid = {
    modelId: "model-1",
    name: "run-1",
    orgUnit: { ids: ["ou1"] },
    period: {
      type: "MONTHLY",
      periodOffset: 0,
      numberPreviousYearsToInclude: 2,
      numberOfPeriodsToGenerate: 3,
    },
    dataSources: [{ covariate: "rain", dataElementId: "abcdefghijk" }],
  };

  const thresholdValid = {
    orgUnit: { ids: ["OU1"] },
    period: { years: ["2023"], periodType: "Monthly", yearsToInclude: 2 },
    dataElementIds: ["DE1"],
    outputDataElementId: "DE_OUT",
  };

  const cases = [
    {
      name: "prediction-trigger",
      schema: predictionTriggerConfigSchema,
      valid: predictionTriggerValid,
    },
    {
      name: "prediction-data-download",
      schema: predictionDataDownloadConfigSchema,
      valid: { dataElementIds: { "0.5": "abcdefghijk" } },
    },
    {
      name: "threshold-generation",
      schema: thresholdGenerationConfigSchema,
      valid: thresholdValid,
    },
    {
      name: "alert-generation",
      schema: alertGenerationConfigSchema,
      valid: {
        orgUnit: { ids: ["OU1"] },
        period: { periods: ["202301"] },
        thresholdDataElementId: "DE_THRESHOLD",
        valueDataElementIds: ["DE_VALUE"],
      },
    },
    {
      name: "dhis2-analytics-run",
      schema: dhis2AnalyticsRunConfigSchema,
      valid: {
        runOptions: { lastYears: 1 },
        polling: { pollIntervalMs: 5000, maxAttempts: 2 },
      },
    },
  ] as const;

  for (const { name, schema, valid } of cases) {
    it(`round-trips ${name} valid config`, () => {
      const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
      const rebuilt = z.fromJSONSchema(json);
      expect(schema.safeParse(valid).success).toBe(true);
      expect(rebuilt.safeParse(valid).success).toBe(true);
    });
  }

  it("prediction-data-download rejects empty mapping in source schema", () => {
    expect(predictionDataDownloadConfigSchema.safeParse({ dataElementIds: {} }).success).toBe(
      false
    );
  });

  it("climate-openeo-create round-trips valid structural config", () => {
    const valid = {
      datasetId: "x",
      variable: { dataElement: "abcdefghijk" },
      aggregation: { method: "mean" as const },
      period: { periodType: "daily" as const, id: "20240101" },
      orgUnit: { ids: ["ou1"] },
    };
    const json = z.toJSONSchema(climateOpenEoConfigSchema, { target: "draft-2020-12" });
    const rebuilt = z.fromJSONSchema(json);
    expect(climateOpenEoConfigSchema.safeParse(valid).success).toBe(true);
    expect(rebuilt.safeParse(valid).success).toBe(true);
  });
});
