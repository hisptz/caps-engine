import {
  climateOpenEoConfigSchema,
  climateOpenEoContextSchema,
} from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import {
  predictionTriggerConfigSchema,
  predictionTriggerContextSchema,
} from "@/services/worker/services/handlers/predictionTrigger/schemas/config.ts";
import { predictionDataDownloadConfigSchema } from "@/services/worker/services/handlers/predictionDataDownload/schemas/config.ts";
import {
  thresholdGenerationConfigSchema,
  thresholdGenerationContextSchema,
} from "@/services/worker/services/handlers/thresholdGeneration/schemas/config.ts";
import {
  alertGenerationConfigSchema,
  alertGenerationContextSchema,
} from "@/services/worker/services/handlers/alertGeneration/schemas/config.ts";
import { dhis2AnalyticsRunConfigSchema } from "@/services/worker/services/handlers/dhis2AnalyticsRun/schemas/config.ts";
import type { ZodType } from "zod";

export type HandlerRegistryEntry = {
  queueName: string;
  displayName: string;
  description: string;
  tags: string[];
  schemas: {
    config?: ZodType;
    context?: ZodType;
  };
};

export enum Handlers {
  CLIMATE_OPENEO_CREATE = "climate-openeo-create",
  CLIMATE_OPENEO_POLL = "climate-openeo-poll",
  CLIMATE_OPENEO_DOWNLOAD = "climate-openeo-download",
  PREDICTION_TRIGGER = "prediction-trigger",
  PREDICTION_POLL = "prediction-poll",
  PREDICTION_DATA_DOWNLOAD = "prediction-data-download",
  DHIS2_DATA_UPLOAD = "dhis2-data-upload",
  DHIS2_ANALYTICS_RUN = "dhis2-analytics-run",
  THRESHOLD_GENERATION = "threshold-generation",
  ALERT_GENERATION = "alert-generation",
  EVENT_DATA_UPLOAD = "event-data-upload",
}

export const HANDLERS: Map<Handlers, HandlerRegistryEntry> = new Map<
  Handlers,
  HandlerRegistryEntry
>([
  [
    Handlers.CLIMATE_OPENEO_CREATE,
    {
      queueName: "step.climate-openeo-create",
      displayName: "Open Climate Service Create",
      description:
        "Create and start an Open Climate Service batch job for climate data aggregation",
      tags: ["climate", "openeo"],
      schemas: {
        config: climateOpenEoConfigSchema,
        context: climateOpenEoContextSchema,
      },
    },
  ],
  [
    Handlers.CLIMATE_OPENEO_POLL,
    {
      queueName: "step.climate-openeo-poll",
      displayName: "Open Climate Service Poll",
      description: "Poll an Open Climate Service job until it finishes",
      tags: ["climate", "openeo"],
      schemas: {},
    },
  ],
  [
    Handlers.CLIMATE_OPENEO_DOWNLOAD,
    {
      queueName: "step.climate-openeo-download",
      displayName: "Open Climate Service Download",
      description: "Download DHIS2 data values from a finished Open Climate Service job",
      tags: ["climate", "openeo"],
      schemas: {},
    },
  ],
  [
    Handlers.PREDICTION_TRIGGER,
    {
      queueName: "step.prediction-trigger",
      displayName: "Prediction Trigger",
      description: "Trigger prediction generation",
      tags: ["prediction", "chap"],
      schemas: {
        config: predictionTriggerConfigSchema,
        context: predictionTriggerContextSchema,
      },
    },
  ],
  [
    Handlers.PREDICTION_POLL,
    {
      queueName: "step.prediction-poll",
      displayName: "Prediction Poll",
      description: "Poll for prediction generation status",
      tags: ["prediction", "chap"],
      schemas: {},
    },
  ],
  [
    Handlers.PREDICTION_DATA_DOWNLOAD,
    {
      queueName: "step.prediction-data-download",
      displayName: "Prediction Data Download",
      description: "Download prediction data from CHAP",
      tags: ["prediction", "chap"],
      schemas: {
        config: predictionDataDownloadConfigSchema,
      },
    },
  ],
  [
    Handlers.DHIS2_DATA_UPLOAD,
    {
      queueName: "step.dhis2-data-upload",
      displayName: "DHIS2 Data Upload",
      description: "Uploads data from a file to DHIS2",
      tags: ["dhis2"],
      schemas: {},
    },
  ],
  [
    Handlers.DHIS2_ANALYTICS_RUN,
    {
      queueName: "step.dhis2-analytics-run",
      displayName: "DHIS2 Analytics Run",
      description: "Triggers DHIS2 analytics table generation and polls for completion",
      tags: ["dhis2", "analytics"],
      schemas: {
        config: dhis2AnalyticsRunConfigSchema,
      },
    },
  ],
  [
    Handlers.THRESHOLD_GENERATION,
    {
      queueName: "step.threshold-generation",
      displayName: "Threshold Generation",
      description: "Generates thresholds for Malaria Alerts",
      tags: ["threshold"],
      schemas: {
        config: thresholdGenerationConfigSchema,
        context: thresholdGenerationContextSchema,
      },
    },
  ],
  [
    Handlers.ALERT_GENERATION,
    {
      queueName: "step.alert-generation",
      displayName: "Alert Generation",
      description:
        "Compares aggregate values against thresholds and generates DHIS2 tracker events",
      tags: ["alert", "dhis2"],
      schemas: {
        config: alertGenerationConfigSchema,
        context: alertGenerationContextSchema,
      },
    },
  ],
  [
    Handlers.EVENT_DATA_UPLOAD,
    {
      queueName: "step.event-data-upload",
      displayName: "Event Data Upload",
      description: "Uploads tracker events from a file to DHIS2",
      tags: ["dhis2", "alert"],
      schemas: {},
    },
  ],
]);

export const STEP_QUEUES: string[] = Array.from(
  HANDLERS.values().map(({ queueName }) => queueName)
);
