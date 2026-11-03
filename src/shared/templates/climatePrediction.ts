import { createHash } from "node:crypto";
import { z } from "zod";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  pullItemSchema,
  pullItemTarget,
} from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";
import { MAX_ROLLING_COUNT } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import { dhis2RecipientsSchema, hasRecipients } from "@/shared/pipeline/notifications.ts";
import { SOURCE_ROUTE_CODE_PATTERN } from "@/shared/constants/sourceRoutes.ts";
import { cronExprSchema } from "@/shared/utils/cron.ts";

// ============================================================
// Template: Climate → Prediction
// Climate data (and, if pulled, disease data) are fetched in parallel; once all are in,
// analytics runs and, when a CHAP prediction setup is chosen, a prediction runs and the
// modeller is told. Without a setup the workflow only gets the data ready, so the modeller
// can evaluate a model; choosing the setup later adds the prediction steps.
// ============================================================

export const CLIMATE_PREDICTION_TEMPLATE = "climate-prediction";

const uid = z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, {
  message: "Must be a DHIS2 ID (11 letters and digits, starting with a letter)",
});

const periodTypeSchema = z.enum(["WEEKLY", "MONTHLY"]);

export const climateVariableSchema = z.object({
  /** Open Climate Service dataset, e.g. "era5_land.total_precipitation" */
  datasetId: z.string().min(1),
  /** Staging data element the values are written to */
  dataElement: uid,
  aggregation: z.enum(["mean", "min", "max", "sum"]).default("mean"),
});

const diseaseSchema = z.discriminatedUnion("source", [
  /** Case data is already in the staging instance (entered or imported some other way) */
  z.object({ source: z.literal("staging") }),
  /** Pulled from another DHIS2 instance through a connected route */
  z.object({
    source: z.literal("instance"),
    routeCode: z.string().regex(SOURCE_ROUTE_CODE_PATTERN, {
      message: "Pick a connected instance (route code starting with caps-src-)",
    }),
    /** Staging data elements to pull, as the instance's pull mappings say where each comes from */
    mapped: z.array(uid).min(1).optional(),
    /** Workflows made before instance mappings list their own items; they keep working */
    items: z.array(pullItemSchema).min(1).optional(),
    orgUnitMatch: z.enum(["id", "code"]).default("id"),
  }),
]);

/** The staging data elements a disease pull writes into. */
export function diseaseTargets(disease: ClimatePredictionParams["disease"]): string[] {
  if (disease.source !== "instance") return [];
  return disease.mapped ?? (disease.items ?? []).map(pullItemTarget);
}

const predictionSchema = z.object({
  /** CHAP prediction setup; its org units, period type and inputs drive the workflow */
  predictionSetupId: z.number().int().positive(),
  /** Periods to predict ahead */
  periodsAhead: z.number().int().min(1).max(52).default(3),
  /** Modellers told when a prediction has run */
  notify: dhis2RecipientsSchema.default({ users: [], userGroups: [] }),
});

export const climatePredictionParamsSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    /** When the workflow runs; null = started by hand only */
    cronExpr: cronExprSchema.nullable().default(null),
    periodType: periodTypeSchema,
    /** Org units to fetch data for; with a prediction setup, the setup's org units are used */
    orgUnit: z
      .object({
        level: z.number().int().positive().optional(),
        ids: z.array(uid).default([]),
      })
      .optional(),
    /** How many recent periods each scheduled run refreshes */
    recentPeriods: z.number().int().min(1).max(MAX_ROLLING_COUNT.weekly),
    climate: z
      .array(climateVariableSchema)
      .min(1, "Choose at least one climate variable")
      .refine(
        (vars) => new Set(vars.map((v) => v.dataElement)).size === vars.length,
        "Two climate variables write into the same data element"
      ),
    disease: diseaseSchema,
    prediction: predictionSchema.nullable().default(null),
  })
  .superRefine((params, ctx) => {
    if (
      params.disease.source === "instance" &&
      (params.disease.mapped === undefined) === (params.disease.items === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["disease", "mapped"],
        message: "Pick the disease data to pull",
      });
    }
    if (params.periodType === "MONTHLY" && params.recentPeriods > MAX_ROLLING_COUNT.monthly) {
      ctx.addIssue({
        code: "custom",
        path: ["recentPeriods"],
        message: `Refresh at most ${MAX_ROLLING_COUNT.monthly} months per run`,
      });
    }
    const orgUnit = params.orgUnit;
    if (!params.prediction && !(orgUnit && (orgUnit.level || orgUnit.ids.length > 0))) {
      ctx.addIssue({
        code: "custom",
        path: ["orgUnit"],
        message: "Choose org units, or a prediction setup to take them from",
      });
    }
  });

export type ClimatePredictionParams = z.infer<typeof climatePredictionParamsSchema>;

/** What the template needs from a CHAP prediction setup. */
export type TemplatePredictionSetup = {
  id: number;
  name: string;
  backtestId: number;
  periodType: string | null;
  orgUnits: string[];
  covariateSources: { covariate: string; dataElementId: string }[];
};

export type PipelineRole = "climate" | "disease" | "prediction";

export type PlannedStep = {
  name: string;
  handlerKey: Handlers;
  handlerConfig: Record<string, unknown>;
};

export type PlannedPipeline = {
  role: PipelineRole;
  name: string;
  description: string;
  steps: PlannedStep[];
};

/** How the data pipelines lead to the prediction pipeline */
export type PlannedJoin =
  | { kind: "merge"; sources: PipelineRole[]; target: PipelineRole }
  | { kind: "connector"; source: PipelineRole; target: PipelineRole };

export type TemplatePlan = {
  workflow: { name: string; description: string | null; cronExpr: string | null };
  pipelines: PlannedPipeline[];
  join: PlannedJoin;
};

export type TemplateIssue = { path: string; message: string };

/** CHAP stores the period type as "month"/"week"; null when it is something else. */
export function setupPeriodType(setup: TemplatePredictionSetup): "WEEKLY" | "MONTHLY" | null {
  switch (setup.periodType?.toLowerCase()) {
    case "month":
    case "monthly":
      return "MONTHLY";
    case "week":
    case "weekly":
      return "WEEKLY";
    default:
      return null;
  }
}

/** The staging data elements the workflow fills, with where each comes from. */
function suppliedDataElements(params: ClimatePredictionParams): Map<string, string> {
  const supplied = new Map<string, string>();
  for (const variable of params.climate) {
    supplied.set(variable.dataElement, `climate (${variable.datasetId})`);
  }
  for (const id of diseaseTargets(params.disease)) {
    supplied.set(id, "disease data pull");
  }
  return supplied;
}

/**
 * Checks the parameters against the prediction setup: errors stop the workflow from being
 * made, warnings are shown but allowed.
 */
export function checkAgainstSetup(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup
): { errors: TemplateIssue[]; warnings: TemplateIssue[] } {
  const errors: TemplateIssue[] = [];
  const warnings: TemplateIssue[] = [];

  const periodType = setupPeriodType(setup);
  if (!periodType) {
    errors.push({
      path: "prediction.predictionSetupId",
      message: `Prediction setup "${setup.name}" has period type "${setup.periodType}"; CAPS supports weekly and monthly`,
    });
  } else if (periodType !== params.periodType) {
    errors.push({
      path: "periodType",
      message: `Prediction setup "${setup.name}" is ${periodType.toLowerCase()}; fetch ${periodType.toLowerCase()} data to match`,
    });
  }
  if (setup.orgUnits.length === 0) {
    errors.push({
      path: "prediction.predictionSetupId",
      message: `Prediction setup "${setup.name}" has no org units`,
    });
  }

  const supplied = suppliedDataElements(params);
  const used = new Set(setup.covariateSources.map((s) => s.dataElementId));
  for (const source of setup.covariateSources) {
    if (supplied.has(source.dataElementId)) continue;
    warnings.push({
      path: "prediction.predictionSetupId",
      message:
        params.disease.source === "staging"
          ? `"${source.covariate}" (${source.dataElementId}) is not fetched by this workflow; it must already be in staging`
          : `"${source.covariate}" (${source.dataElementId}) is not fetched by this workflow`,
    });
  }
  params.climate.forEach((variable, index) => {
    if (!used.has(variable.dataElement)) {
      warnings.push({
        path: `climate.${index}.dataElement`,
        message: `${variable.datasetId} goes into ${variable.dataElement}, which the prediction setup does not use`,
      });
    }
  });

  return { errors, warnings };
}

/** An Open Climate Service dataset and how often it has values ("daily", "monthly", …). */
export type ClimateDataset = { id: string; periodType: string | null };

const PERIOD_LENGTH: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * Each climate variable needs a dataset OCS has, with values at least as often as the
 * workflow's periods: daily data adds up to weeks, monthly data cannot be split into weeks.
 */
export function checkClimateDatasets(
  params: ClimatePredictionParams,
  datasets: ClimateDataset[]
): TemplateIssue[] {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const wanted = PERIOD_LENGTH[params.periodType.toLowerCase()]!;
  return params.climate.flatMap((variable, index): TemplateIssue[] => {
    const path = `climate.${index}.datasetId`;
    const dataset = byId.get(variable.datasetId);
    if (!dataset) {
      return [
        {
          path,
          message: `Open Climate Service has no dataset "${variable.datasetId}"; ingest it on the Climate data page first`,
        },
      ];
    }
    const length = dataset.periodType ? PERIOD_LENGTH[dataset.periodType] : undefined;
    if (length === undefined) {
      return [
        {
          path,
          message: `"${variable.datasetId}" is not a time series (${dataset.periodType ?? "static"})`,
        },
      ];
    }
    if (length > wanted) {
      return [
        {
          path,
          message: `"${variable.datasetId}" is ${dataset.periodType}; it cannot give ${params.periodType.toLowerCase()} values`,
        },
      ];
    }
    return [];
  });
}

function orgUnitSelection(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null
): { ids: string[]; level?: number } {
  if (setup) return { ids: setup.orgUnits };
  return { ids: params.orgUnit?.ids ?? [], level: params.orgUnit?.level };
}

const DEFAULT_IMPORT = { importStrategy: "CREATE_AND_UPDATE" };

/** The workflow, pipelines and steps the parameters stand for. Pure: no lookups. */
export function buildClimatePredictionPlan(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null
): TemplatePlan {
  const orgUnit = orgUnitSelection(params, setup);
  const pipelines: PlannedPipeline[] = [];

  pipelines.push({
    role: "climate",
    name: `${params.name} · Climate data`,
    description: "Fetches climate data from Open Climate Service into staging",
    steps: [
      // OCS can only serve what it has ingested; bring every dataset up to date first
      {
        name: "Sync climate datasets",
        handlerKey: Handlers.OPEN_CLIMATE_SERVICE_SYNC,
        handlerConfig: {
          datasetIds: [...new Set(params.climate.map((v) => v.datasetId))],
        },
      },
      ...params.climate.flatMap((variable): PlannedStep[] => [
        {
          name: `Request ${variable.datasetId}`,
          handlerKey: Handlers.CLIMATE_OPENEO_CREATE,
          handlerConfig: {
            datasetId: variable.datasetId,
            variable: { dataElement: variable.dataElement },
            aggregation: { method: variable.aggregation },
            period: {
              mode: "rolling",
              periodType: params.periodType.toLowerCase(),
              count: params.recentPeriods,
            },
            orgUnit: {
              ...(orgUnit.ids.length > 0 ? { ids: orgUnit.ids } : {}),
              ...(orgUnit.level ? { levels: [String(orgUnit.level)] } : {}),
            },
          },
        },
        {
          name: `Wait for ${variable.datasetId}`,
          handlerKey: Handlers.CLIMATE_OPENEO_POLL,
          handlerConfig: {},
        },
        {
          name: `Download ${variable.datasetId}`,
          handlerKey: Handlers.CLIMATE_OPENEO_DOWNLOAD,
          handlerConfig: {},
        },
        {
          name: `Import ${variable.datasetId}`,
          handlerKey: Handlers.DHIS2_DATA_UPLOAD,
          handlerConfig: DEFAULT_IMPORT,
        },
      ]),
    ],
  });

  if (params.disease.source === "instance") {
    pipelines.push({
      role: "disease",
      name: `${params.name} · Disease data`,
      description: "Pulls disease case data from the source instance into staging",
      steps: [
        {
          name: "Pull disease data",
          handlerKey: Handlers.DHIS2_INSTANCE_PULL,
          handlerConfig: {
            routeCode: params.disease.routeCode,
            ...(params.disease.mapped
              ? { mapped: params.disease.mapped }
              : { items: params.disease.items }),
            orgUnit: {
              ...(orgUnit.ids.length > 0 ? { ids: orgUnit.ids } : {}),
              ...(orgUnit.level ? { levels: [orgUnit.level] } : {}),
            },
            orgUnitMatch: params.disease.orgUnitMatch,
            period: {
              mode: "relative",
              periodType: params.periodType,
              count: params.recentPeriods,
              offset: 1,
            },
          },
        },
        {
          name: "Import disease data",
          handlerKey: Handlers.DHIS2_DATA_UPLOAD,
          handlerConfig: DEFAULT_IMPORT,
        },
      ],
    });
  }

  const predictionSteps: PlannedStep[] = [
    { name: "Run analytics", handlerKey: Handlers.DHIS2_ANALYTICS_RUN, handlerConfig: {} },
  ];
  if (params.prediction && setup) {
    predictionSteps.push(
      {
        name: "Start prediction",
        handlerKey: Handlers.PREDICTION_TRIGGER,
        handlerConfig: {
          backtestId: setup.backtestId,
          predictionSetupId: setup.id,
          name: `${params.name} prediction`,
          period: { periodOffset: 1, numberOfPeriodsToGenerate: params.prediction.periodsAhead },
        },
      },
      { name: "Wait for prediction", handlerKey: Handlers.PREDICTION_POLL, handlerConfig: {} }
    );
    if (hasRecipients(params.prediction.notify)) {
      predictionSteps.push({
        name: "Tell the modeller",
        handlerKey: Handlers.DHIS2_NOTIFY,
        handlerConfig: {
          recipients: params.prediction.notify,
          subject: `CAPS: a new ${params.name} prediction is ready`,
          message:
            `A new prediction from "${setup.name}" ran on {{date}}. ` +
            "Review it in the Modelling App. Run details: {{runUrl}}",
        },
      });
    }
  }
  pipelines.push({
    role: "prediction",
    name: `${params.name} · Prediction`,
    description:
      params.prediction && setup
        ? `Runs analytics, then the "${setup.name}" prediction in CHAP`
        : "Runs analytics so the data can be evaluated; choose a prediction setup to also predict",
    steps: predictionSteps,
  });

  const join: PlannedJoin =
    params.disease.source === "instance"
      ? { kind: "merge", sources: ["climate", "disease"], target: "prediction" }
      : { kind: "connector", source: "climate", target: "prediction" };

  return {
    workflow: {
      name: params.name,
      description: params.description ?? null,
      cronExpr: params.cronExpr,
    },
    pipelines,
    join,
  };
}

/** Identifies a pipeline's steps, to notice when someone has changed them by hand. */
export function stepsFingerprint(
  steps: { name: string; handlerKey: string; handlerConfig: unknown }[]
): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)])
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(steps.map((s) => [s.name, s.handlerKey, stable(s.handlerConfig ?? {})])))
    .digest("hex")
    .slice(0, 16);
}

/** What a created workflow remembers about the pipelines and join it was given. */
export type TemplateState = {
  pipelines: Partial<Record<PipelineRole, { id: string; fingerprint: string }>>;
  join: { kind: "merge" | "connector"; id: string } | null;
};
