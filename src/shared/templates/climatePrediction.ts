import { createHash } from "node:crypto";
import { z } from "zod";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import {
  pullItemSchema,
  pullItemTarget,
} from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";
import { MAX_ROLLING_COUNT } from "@/services/worker/services/handlers/climateOpenEo/schemas/config.ts";
import {
  dhis2RecipientsSchema,
  hasRecipients,
  type Dhis2Recipients,
} from "@/shared/pipeline/notifications.ts";
import {
  SOURCE_ROUTE_CODE_PATTERN,
  SOURCE_ROUTE_CODE_PREFIX,
} from "@/shared/constants/sourceRoutes.ts";
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
  label: z.string().trim().min(1).max(60).optional(),
  dataElement: uid,
  aggregation: z.enum(["mean", "min", "max", "sum"]).default("mean"),
});

/** What the disease data is called in names, e.g. "malaria cases" */
const diseaseLabel = z.string().trim().min(1).max(60).optional();

const diseaseSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("staging"), label: diseaseLabel }),
  z.object({
    source: z.literal("instance"),
    label: diseaseLabel,
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
    /** Empty when the workflow only pulls data or only predicts */
    climate: z
      .array(climateVariableSchema)
      .default([])
      .refine(
        (vars) => new Set(vars.map((v) => v.dataElement)).size === vars.length,
        "Two climate variables write into the same data element"
      ),
    disease: diseaseSchema,
    prediction: predictionSchema.nullable().default(null),
    /** Run analytics in staging once the data is saved */
    runAnalytics: z.boolean().default(true),
    notify: z
      .object({
        /** Told when the workflow's last pipeline succeeds */
        onSuccess: dhis2RecipientsSchema.default({ users: [], userGroups: [] }),
        /** Told when any of the workflow's pipelines fails */
        onFailure: dhis2RecipientsSchema.default({ users: [], userGroups: [] }),
      })
      .default({
        onSuccess: { users: [], userGroups: [] },
        onFailure: { users: [], userGroups: [] },
      }),
  })
  .superRefine((params, ctx) => {
    if (params.climate.length === 0 && params.disease.source !== "instance" && !params.prediction) {
      ctx.addIssue({
        code: "custom",
        path: ["climate"],
        message: "Choose climate data, data to pull from an instance, or a prediction setup",
      });
    }
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

/**
 * "prediction" is the pipeline that runs after the data pipelines: it runs analytics and,
 * with a setup, predicts. The name stays for workflows made before analytics could stand alone.
 */
export type PipelineRole = "climate" | "disease" | "prediction";

export type PlannedStep = {
  name: string;
  description: string;
  handlerKey: Handlers;
  handlerConfig: Record<string, unknown>;
};

export type PlannedPipeline = {
  role: PipelineRole;
  name: string;
  description: string;
  /** Who is told when the pipeline fails; none when empty */
  onFailure: Dhis2Recipients;
  steps: PlannedStep[];
};

/** How the data pipelines lead to the pipeline after them */
export type PlannedJoin =
  | { kind: "merge"; name: string; sources: PipelineRole[]; target: PipelineRole }
  | { kind: "connector"; name: string; source: PipelineRole; target: PipelineRole };

export type TemplatePlan = {
  workflow: { name: string; description: string | null; cronExpr: string | null };
  pipelines: PlannedPipeline[];
  /** Null when there is only one pipeline, or the data pipelines run side by side alone */
  join: PlannedJoin | null;
};

/** Names looked up outside the plan, for pipeline and step names. */
export type TemplateNames = {
  /** The connected instance's name, e.g. "HMIS" */
  instanceName?: string | null;
  /** Staging data element names by id, for naming climate variables and pulled data */
  dataElementNames?: Record<string, string>;
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

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "the latest week", "the last 12 months" */
function recentPhrase(params: ClimatePredictionParams): string {
  const unit = params.periodType === "WEEKLY" ? "week" : "month";
  return params.recentPeriods === 1
    ? `the latest ${unit}`
    : `the last ${params.recentPeriods} ${unit}s`;
}

function orgUnitPhrase(params: ClimatePredictionParams, setup: TemplatePredictionSetup | null) {
  if (setup) return `the ${plural(setup.orgUnits.length, "org unit")} of "${setup.name}"`;
  const ids = params.orgUnit?.ids ?? [];
  const level = params.orgUnit?.level;
  if (ids.length > 0 && level) {
    return `org units at level ${level} under ${plural(ids.length, "chosen org unit")}`;
  }
  if (level) return `every org unit at level ${level}`;
  return plural(ids.length, "chosen org unit");
}

/** "rainfall", "rainfall and temperature", "rainfall, humidity and temperature" */
function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The connected instance's name, or its route code without the prefix: "caps-src-hmis" → "HMIS" */
function instanceLabel(routeCode: string, names: TemplateNames): string {
  const name = names.instanceName?.trim();
  if (name) return name;
  return (
    routeCode.startsWith(SOURCE_ROUTE_CODE_PREFIX)
      ? routeCode.slice(SOURCE_ROUTE_CODE_PREFIX.length)
      : routeCode
  ).toUpperCase();
}

/** A climate variable by its label, else its data element's name, else the dataset id */
const variableLabel = (
  variable: ClimatePredictionParams["climate"][number],
  names: TemplateNames
) => variable.label ?? names.dataElementNames?.[variable.dataElement] ?? variable.datasetId;

/** The pulled data by its label, else its data elements' names: "Malaria cases and 2 more" */
function pulledLabel(params: ClimatePredictionParams, names: TemplateNames): string {
  if (params.disease.label) return params.disease.label;
  const found = diseaseTargets(params.disease).flatMap((id) => {
    const name = names.dataElementNames?.[id];
    return name ? [name] : [];
  });
  if (found.length === 0) return "data";
  if (found.length <= 2) return found.join(" and ");
  return `${found[0]} and ${found.length - 1} more`;
}

const ANALYTICS_STEP: PlannedStep = {
  name: "Run analytics in staging",
  description:
    "Rebuilds the analytics tables in staging so the new values show in dashboards and can be used by CHAP.",
  handlerKey: Handlers.DHIS2_ANALYTICS_RUN,
  handlerConfig: {},
};

function successStep(recipients: Dhis2Recipients, what: string): PlannedStep {
  return {
    name: "Tell the team the run succeeded",
    description: "Messages the chosen users that the pipeline finished, with a link to the run.",
    handlerKey: Handlers.DHIS2_NOTIFY,
    handlerConfig: {
      recipients,
      subject: `CAPS: ${what} succeeded`,
      message: "{{pipelineName}} finished on {{date}}. Run details: {{runUrl}}",
    },
  };
}

function climatePipeline(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null,
  names: TemplateNames,
  suffix: string
): PlannedPipeline {
  const orgUnit = orgUnitSelection(params, setup);
  const period = params.periodType === "WEEKLY" ? "weekly" : "monthly";
  const labels = params.climate.map((v) => variableLabel(v, names));
  return {
    role: "climate",
    name: `Fetch ${period} climate data from Open Climate Service${suffix}`,
    description: `Fetches ${recentPhrase(params)} of ${listWords(labels)} for ${orgUnitPhrase(params, setup)} from Open Climate Service and saves them in staging.`,
    onFailure: params.notify.onFailure,
    steps: [
      // OCS can only serve what it has ingested; bring every dataset up to date first
      {
        name: "Update climate datasets",
        description:
          "Brings the chosen Open Climate Service datasets up to date, so the newest period is there.",
        handlerKey: Handlers.OPEN_CLIMATE_SERVICE_SYNC,
        handlerConfig: {
          datasetIds: [...new Set(params.climate.map((v) => v.datasetId))],
        },
      },
      ...params.climate.flatMap((variable): PlannedStep[] => {
        const label = variableLabel(variable, names);
        return [
          {
            name: `Request ${label} from Open Climate Service`,
            description: `Asks for ${period} ${label} (${variable.datasetId}), ${variable.aggregation} per org unit, and gets a job back.`,
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
            name: `Wait for ${label} to be calculated`,
            description: "Checks the Open Climate Service job until it finishes.",
            handlerKey: Handlers.CLIMATE_OPENEO_POLL,
            handlerConfig: {},
          },
          {
            name: `Download ${label} values`,
            description: "Downloads the finished values as DHIS2 data values.",
            handlerKey: Handlers.CLIMATE_OPENEO_DOWNLOAD,
            handlerConfig: {},
          },
          {
            name: `Save ${label} to staging`,
            description: `Imports the values into data element ${variable.dataElement} (create and update).`,
            handlerKey: Handlers.DHIS2_DATA_UPLOAD,
            handlerConfig: DEFAULT_IMPORT,
          },
        ];
      }),
    ],
  };
}

function pullPipeline(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null,
  names: TemplateNames,
  suffix: string
): PlannedPipeline | null {
  const disease = params.disease;
  if (disease.source !== "instance") return null;
  const orgUnit = orgUnitSelection(params, setup);
  const instance = instanceLabel(disease.routeCode, names);
  const label = pulledLabel(params, names);
  return {
    role: "disease",
    name: `Pull ${label} from ${instance}${suffix}`,
    description: `Pulls ${recentPhrase(params)} of ${label} from ${instance} for ${orgUnitPhrase(params, setup)} and saves them in staging.`,
    onFailure: params.notify.onFailure,
    steps: [
      {
        name: `Pull ${label} from ${instance}`,
        description: `Reads the mapped data elements from ${instance} through its connected-instance route.`,
        handlerKey: Handlers.DHIS2_INSTANCE_PULL,
        handlerConfig: {
          routeCode: disease.routeCode,
          ...(disease.mapped ? { mapped: disease.mapped } : { items: disease.items }),
          orgUnit: {
            ...(orgUnit.ids.length > 0 ? { ids: orgUnit.ids } : {}),
            ...(orgUnit.level ? { levels: [orgUnit.level] } : {}),
          },
          orgUnitMatch: disease.orgUnitMatch,
          period: {
            mode: "relative",
            periodType: params.periodType,
            count: params.recentPeriods,
            offset: 1,
          },
        },
      },
      {
        name: `Save ${label} to staging`,
        description: "Imports the pulled values into staging (create and update).",
        handlerKey: Handlers.DHIS2_DATA_UPLOAD,
        handlerConfig: DEFAULT_IMPORT,
      },
    ],
  };
}

/** The pipeline after the data: analytics (when there is new data) and the prediction. */
function finalPipeline(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null,
  withAnalytics: boolean,
  suffix: string
): PlannedPipeline {
  const prediction = params.prediction && setup ? params.prediction : null;
  if (!prediction || !setup) {
    return {
      role: "prediction",
      name: `Run analytics in staging${suffix}`,
      description:
        "Rebuilds the analytics tables in staging once all the data is in, so it shows in dashboards and can be used by CHAP.",
      onFailure: params.notify.onFailure,
      steps: [ANALYTICS_STEP],
    };
  }
  const ahead = plural(prediction.periodsAhead, params.periodType === "WEEKLY" ? "week" : "month");
  const tellModeller = hasRecipients(prediction.notify);
  const steps: PlannedStep[] = [
    ...(withAnalytics ? [ANALYTICS_STEP] : []),
    {
      name: `Start the "${setup.name}" prediction in CHAP`,
      description: `Sends the setup's data from staging analytics to CHAP and asks for ${ahead} ahead.`,
      handlerKey: Handlers.PREDICTION_TRIGGER,
      handlerConfig: {
        backtestId: setup.backtestId,
        predictionSetupId: setup.id,
        name: `${params.name} prediction`,
        period: { periodOffset: 1, numberOfPeriodsToGenerate: prediction.periodsAhead },
      },
    },
    {
      name: "Wait for CHAP to finish",
      description: "Checks the CHAP job until it succeeds or fails.",
      handlerKey: Handlers.PREDICTION_POLL,
      handlerConfig: {},
    },
  ];
  if (tellModeller) {
    steps.push({
      name: "Tell the modeller the prediction is ready",
      description: "Messages the chosen users with a link to review it in the Modelling App.",
      handlerKey: Handlers.DHIS2_NOTIFY,
      handlerConfig: {
        recipients: prediction.notify,
        subject: `CAPS: a new ${params.name} prediction is ready`,
        message:
          `A new prediction from "${setup.name}" ran on {{date}}. ` +
          "Review it in the Modelling App. Run details: {{runUrl}}",
      },
    });
  }
  return {
    role: "prediction",
    name: `${withAnalytics ? "Run analytics and the" : "Run the"} "${setup.name}" prediction${suffix}`,
    description:
      `${withAnalytics ? "Runs analytics in staging, then runs" : "Runs"} the "${setup.name}" prediction setup in CHAP for the next ${ahead}` +
      (tellModeller ? " and tells the modeller." : "."),
    onFailure: params.notify.onFailure,
    steps,
  };
}

/** The workflow, pipelines and steps the parameters stand for. Pure: no lookups. */
export function buildClimatePredictionPlan(
  params: ClimatePredictionParams,
  setup: TemplatePredictionSetup | null,
  names: TemplateNames = {}
): TemplatePlan {
  // Pipeline names are unique across CAPS; the workflow's name keeps them apart
  const suffix = ` · ${params.name}`;
  const data = [
    params.climate.length > 0 ? climatePipeline(params, setup, names, suffix) : null,
    pullPipeline(params, setup, names, suffix),
  ].filter((p): p is PlannedPipeline => p !== null);

  const predicts = Boolean(params.prediction && setup);
  // One data pipeline and no prediction: analytics is its own last step
  const analyticsInline = !predicts && data.length === 1 && params.runAnalytics;
  if (analyticsInline) data[0]!.steps.push(ANALYTICS_STEP);
  const needsFinal = predicts || (data.length > 1 && params.runAnalytics);

  const final = needsFinal
    ? finalPipeline(params, setup, data.length > 0 && params.runAnalytics, suffix)
    : null;
  const pipelines = final ? [...data, final] : data;

  // Whatever ends the workflow tells the team, unless it already tells the modeller
  if (hasRecipients(params.notify.onSuccess)) {
    const ends = final ? [final] : data;
    for (const pipeline of ends) {
      if (pipeline.steps.at(-1)?.handlerKey !== Handlers.DHIS2_NOTIFY) {
        pipeline.steps.push(successStep(params.notify.onSuccess, params.name));
      }
    }
  }

  // Shown inside the workflow only, so no workflow name is needed
  const pulledName = params.disease.source === "instance" ? pulledLabel(params, names) : "data";
  const pulled = pulledName === "data" ? "pulled data" : pulledName;
  const next = predicts ? "predict" : "run analytics";
  let join: PlannedJoin | null = null;
  if (final && data.length === 2) {
    join = {
      kind: "merge",
      name: `Wait for climate data and ${pulled}, then ${next}`,
      sources: data.map((p) => p.role),
      target: final.role,
    };
  } else if (final && data.length === 1) {
    join = {
      kind: "connector",
      name: `After ${data[0]!.role === "climate" ? "climate data" : pulled}, ${next}`,
      source: data[0]!.role,
      target: final.role,
    };
  }

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
