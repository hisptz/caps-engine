import { MergeTriggerRule, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { badRequest, conflict, notFound, unprocessable } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { dhis2RestClient } from "@/shared/clients/dhis.ts";
import { validateHandlerConfig } from "@/shared/handlers/catalog.ts";
import { runPeriodRangeSchema, type RunPeriodRange } from "@/shared/pipeline/runPeriod.ts";
import { startWorkflow, type StartWorkflowResult } from "@/shared/pipeline/workflows.ts";
import { getPredictionSetup } from "@/services/api/modules/evaluations/service.ts";
import { testSourceRoute } from "@/services/api/modules/sourceRoutes/service.ts";
import { ClimateService } from "@/services/api/modules/climate/service.ts";
import { nextRunAt, WorkflowService } from "@/services/api/modules/workflows/service.ts";
import { pullItemTarget } from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";
import {
  buildClimatePredictionPlan,
  checkAgainstSetup,
  checkClimateDatasets,
  CLIMATE_PREDICTION_TEMPLATE,
  climatePredictionParamsSchema,
  stepsFingerprint,
  type ClimateDataset,
  type ClimatePredictionParams,
  type PipelineRole,
  type PlannedPipeline,
  type TemplateIssue,
  type TemplatePlan,
  type TemplatePredictionSetup,
  type TemplateState,
} from "@/shared/templates/climatePrediction.ts";
import type {
  CreateFromTemplateBody,
  UpdateTemplateSetupBody,
} from "@/services/api/modules/templates/model.ts";

type Tx = Prisma.TransactionClient;

/** Outside lookups the checks need; replaced in tests. */
export type TemplateLookups = {
  predictionSetup(id: number): Promise<{ setup: TemplatePredictionSetup | null; error?: string }>;
  /** Data elements not found in staging; null when they could not be checked */
  missingDataElements(ids: string[]): Promise<string[] | null>;
  routeReachable(routeCode: string): Promise<boolean>;
  /** Datasets Open Climate Service has ingested; null when OCS could not be reached */
  climateDatasets(): Promise<ClimateDataset[] | null>;
};

type StacCollection = {
  id: string;
  "cube:dimensions"?: Record<string, { type?: string; step?: string | null }>;
};

const STEP_PERIOD_TYPES: Record<string, string> = { P1D: "daily", P7D: "weekly", P1M: "monthly" };

/** What the workflow can fetch: datasets OCS has ingested, with their time step. */
function climateDatasetOf(collection: StacCollection): ClimateDataset {
  const time = Object.values(collection["cube:dimensions"] ?? {}).find(
    (d) => d.type === "temporal"
  );
  return {
    id: collection.id,
    periodType: time?.step ? (STEP_PERIOD_TYPES[time.step] ?? time.step) : null,
  };
}

export const defaultLookups: TemplateLookups = {
  async predictionSetup(id) {
    const { setup, error } = await getPredictionSetup(id);
    return {
      error,
      setup: setup && {
        id: setup.id,
        name: setup.name,
        backtestId: setup.backtestId,
        periodType: setup.periodType,
        orgUnits: setup.orgUnits,
        covariateSources: setup.covariateSources,
      },
    };
  },
  async missingDataElements(ids) {
    try {
      const { data } = await dhis2RestClient.get<{ dataElements?: { id: string }[] }>(
        "/dataElements",
        { params: { filter: `id:in:[${ids.join(",")}]`, fields: "id", paging: false } }
      );
      const found = new Set((data.dataElements ?? []).map((d) => d.id));
      return ids.filter((id) => !found.has(id));
    } catch {
      return null;
    }
  },
  async routeReachable(routeCode) {
    return (await testSourceRoute(routeCode)).reachable;
  },
  async climateDatasets() {
    try {
      const { collections } = await new ClimateService().listCollections();
      return (collections as StacCollection[]).map(climateDatasetOf);
    } catch {
      return null;
    }
  },
};

export type TemplatePreview = {
  params: ClimatePredictionParams | null;
  setup: TemplatePredictionSetup | null;
  plan: TemplatePlan | null;
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
};

const TEMPLATES = [
  {
    id: CLIMATE_PREDICTION_TEMPLATE,
    name: "Climate → Prediction",
    description:
      "Fetch climate data (and disease data from another instance, if needed) in parallel, then run analytics and a CHAP prediction and tell the modeller",
  },
];

const MERGE_TIMEOUT_MINUTES = 12 * 60;

function isPrismaDuplicate(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function parseRange(range: CreateFromTemplateBody["backfill"]): RunPeriodRange | undefined {
  if (!range) return undefined;
  const parsed = runPeriodRangeSchema.safeParse(range);
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues[0]?.message ?? "Invalid period range",
      ApiErrorCode.WORKFLOW_RUN_PERIOD_INVALID
    );
  }
  return parsed.data;
}

export class TemplateService {
  private workflows = new WorkflowService();

  constructor(private lookups: TemplateLookups = defaultLookups) {}

  listTemplates() {
    return TEMPLATES;
  }

  private assertTemplate(template: string) {
    if (!TEMPLATES.some((t) => t.id === template)) {
      throw notFound("Template not found", ApiErrorCode.TEMPLATE_NOT_FOUND);
    }
  }

  /** Check the parameters and show what they would create; nothing is saved. */
  async preview(template: string, rawParams: unknown): Promise<TemplatePreview> {
    this.assertTemplate(template);
    const parsed = climatePredictionParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return {
        params: null,
        setup: null,
        plan: null,
        warnings: [],
        errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      };
    }
    const params = parsed.data;
    const errors: TemplateIssue[] = [];
    const warnings: TemplateIssue[] = [];

    let setup: TemplatePredictionSetup | null = null;
    if (params.prediction) {
      const found = await this.lookups.predictionSetup(params.prediction.predictionSetupId);
      setup = found.setup;
      if (!setup) {
        errors.push({
          path: "prediction.predictionSetupId",
          message: found.error
            ? `Could not reach CHAP to read the prediction setup: ${found.error}`
            : "Prediction setup not found in CHAP",
        });
      } else {
        const checked = checkAgainstSetup(params, setup);
        errors.push(...checked.errors);
        warnings.push(...checked.warnings);
      }
    }

    const written = this.dataElementsWritten(params);
    const [missing, reachable, datasets] = await Promise.all([
      this.lookups.missingDataElements([...written.keys()]),
      params.disease.source === "instance"
        ? this.lookups.routeReachable(params.disease.routeCode)
        : Promise.resolve(true),
      this.lookups.climateDatasets(),
    ]);
    if (missing === null) {
      warnings.push({ path: "", message: "Could not check the data elements in staging" });
    } else {
      for (const id of missing) {
        errors.push({
          path: written.get(id)!,
          message: `Data element ${id} does not exist in staging`,
        });
      }
    }
    if (datasets === null) {
      warnings.push({
        path: "climate",
        message: "Could not reach Open Climate Service to check the datasets",
      });
    } else {
      errors.push(...checkClimateDatasets(params, datasets));
    }
    if (!reachable) {
      errors.push({
        path: "disease.routeCode",
        message: "The source instance could not be reached through its route",
      });
    }

    // Without the setup there is nothing sensible to show
    if (params.prediction && !setup) {
      return { params, setup, plan: null, errors, warnings };
    }
    const plan = buildClimatePredictionPlan(params, setup);
    for (const pipeline of plan.pipelines) {
      pipeline.steps.forEach((step, index) => {
        const result = validateHandlerConfig(step.handlerKey, step.handlerConfig);
        if (!result.success) {
          errors.push({
            path: `${pipeline.role}.steps.${index}`,
            message: `${step.name}: ${result.issues[0]?.message ?? "invalid settings"}`,
          });
        }
      });
    }
    return { params, setup, plan, errors, warnings };
  }

  /** Staging data elements the workflow writes into, with the field that names each */
  private dataElementsWritten(params: ClimatePredictionParams): Map<string, string> {
    const written = new Map<string, string>();
    params.climate.forEach((v, i) => written.set(v.dataElement, `climate.${i}.dataElement`));
    if (params.disease.source === "instance") {
      params.disease.items.forEach((item, i) =>
        written.set(pullItemTarget(item), `disease.items.${i}`)
      );
    }
    return written;
  }

  private async checkedPlan(template: string, rawParams: unknown) {
    const preview = await this.preview(template, rawParams);
    if (preview.errors.length > 0 || !preview.plan || !preview.params) {
      throw unprocessable(
        preview.errors[0]?.message ?? "The template parameters are not valid",
        ApiErrorCode.TEMPLATE_INVALID,
        { errors: preview.errors, warnings: preview.warnings }
      );
    }
    return { params: preview.params, plan: preview.plan };
  }

  /** Create the workflow, its pipelines and how they connect; optionally backfill once. */
  async create(template: string, body: CreateFromTemplateBody) {
    const backfill = parseRange(body.backfill);
    const { params, plan } = await this.checkedPlan(template, body.params);

    let workflowId: string;
    try {
      workflowId = await apiDb.$transaction(async (tx) => {
        const workflow = await tx.workflow.create({
          data: {
            ...plan.workflow,
            nextRunAt: nextRunAt(plan.workflow.cronExpr),
            template,
            templateParams: params as Prisma.InputJsonObject,
          },
        });
        const state: TemplateState = { pipelines: {}, join: null };
        for (const planned of plan.pipelines) {
          state.pipelines[planned.role] = await this.createPipeline(tx, workflow.id, planned);
        }
        state.join = await this.createJoin(tx, workflow.id, plan, state);
        await tx.workflow.update({
          where: { id: workflow.id },
          data: { templateState: state as Prisma.InputJsonObject },
        });
        return workflow.id;
      });
    } catch (err) {
      if (isPrismaDuplicate(err)) {
        throw conflict(
          `A workflow or pipeline named "${params.name}" already exists`,
          ApiErrorCode.WORKFLOW_DUPLICATE_NAME
        );
      }
      throw err;
    }

    let backfillRun: StartWorkflowResult | null = null;
    if (backfill) {
      backfillRun = await startWorkflow(apiDb, workflowId, {
        triggeredBy: "api",
        period: backfill,
      });
    }
    return { workflow: await this.workflows.getWorkflow(workflowId), backfillRun };
  }

  /** The template and parameters a workflow was made from, and which pipelines changed since. */
  async getSetup(workflowId: string) {
    const workflow = await apiDb.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw notFound("Workflow not found", ApiErrorCode.WORKFLOW_NOT_FOUND);
    if (!workflow.template) {
      throw notFound(
        "Workflow was not made from a template",
        ApiErrorCode.WORKFLOW_NOT_FROM_TEMPLATE
      );
    }
    return {
      template: workflow.template,
      params: {
        ...(workflow.templateParams as Prisma.JsonObject),
        name: workflow.name,
        description: workflow.description ?? undefined,
        cronExpr: workflow.cronExpr,
      },
      editedPipelines: await this.editedPipelines(workflow.templateState as TemplateState | null),
    };
  }

  /** Pipelines whose steps differ from what the template last set. */
  private async editedPipelines(state: TemplateState | null, db: Tx = apiDb) {
    const entries = Object.entries(state?.pipelines ?? {});
    const pipelines = await db.pipeline.findMany({
      where: { id: { in: entries.map(([, p]) => p.id) } },
      select: {
        id: true,
        name: true,
        steps: {
          select: { name: true, handlerKey: true, handlerConfig: true },
          orderBy: { stepOrder: "asc" },
        },
      },
    });
    const byId = new Map(pipelines.map((p) => [p.id, p]));
    return entries.flatMap(([role, stored]) => {
      const current = byId.get(stored.id);
      if (!current || stepsFingerprint(current.steps) === stored.fingerprint) return [];
      return [{ role: role as PipelineRole, id: current.id, name: current.name }];
    });
  }

  /** Apply new parameters to a workflow made from the template, updating the same pipelines. */
  async updateSetup(workflowId: string, body: UpdateTemplateSetupBody) {
    const workflow = await apiDb.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw notFound("Workflow not found", ApiErrorCode.WORKFLOW_NOT_FOUND);
    if (!workflow.template) {
      throw notFound(
        "Workflow was not made from a template",
        ApiErrorCode.WORKFLOW_NOT_FROM_TEMPLATE
      );
    }
    const { params, plan } = await this.checkedPlan(workflow.template, body.params);
    const previous = (workflow.templateState as TemplateState | null) ?? {
      pipelines: {},
      join: null,
    };

    if (!body.force) {
      const edited = await this.editedPipelines(previous);
      if (edited.length > 0) {
        throw conflict(
          `Changed by hand since the template set them: ${edited.map((p) => p.name).join(", ")}`,
          ApiErrorCode.TEMPLATE_EDITED,
          { editedPipelines: edited }
        );
      }
    }

    try {
      await apiDb.$transaction(async (tx) => {
        await tx.workflow.update({
          where: { id: workflowId },
          data: {
            ...plan.workflow,
            nextRunAt: nextRunAt(plan.workflow.cronExpr),
            templateParams: params as Prisma.InputJsonObject,
          },
        });

        const existing = await tx.pipeline.findMany({
          where: {
            id: { in: Object.values(previous.pipelines).map((p) => p.id) },
            workflowId,
          },
          select: { id: true },
        });
        const stillThere = new Set(existing.map((p) => p.id));
        const planned = new Set(plan.pipelines.map((p) => p.role));

        // Whatever joined the old pipelines may no longer fit; it is rebuilt below
        const keepJoin = await this.joinStillFits(tx, previous, plan);
        if (!keepJoin) await this.deleteJoin(tx, previous.join);

        for (const [role, stored] of Object.entries(previous.pipelines)) {
          if (!planned.has(role as PipelineRole) && stillThere.has(stored.id)) {
            await this.retirePipeline(tx, stored.id);
          }
        }

        const state: TemplateState = { pipelines: {}, join: keepJoin ? previous.join : null };
        for (const pipeline of plan.pipelines) {
          const stored = previous.pipelines[pipeline.role];
          state.pipelines[pipeline.role] =
            stored && stillThere.has(stored.id)
              ? await this.replaceSteps(tx, stored.id, pipeline)
              : await this.createPipeline(tx, workflowId, pipeline);
        }
        if (!keepJoin) state.join = await this.createJoin(tx, workflowId, plan, state);

        await tx.workflow.update({
          where: { id: workflowId },
          data: { templateState: state as Prisma.InputJsonObject },
        });
      });
    } catch (err) {
      if (isPrismaDuplicate(err)) {
        throw conflict(
          `A workflow or pipeline named "${params.name}" already exists`,
          ApiErrorCode.WORKFLOW_DUPLICATE_NAME
        );
      }
      throw err;
    }
    return this.workflows.getWorkflow(workflowId);
  }

  private async createPipeline(tx: Tx, workflowId: string, planned: PlannedPipeline) {
    const pipeline = await tx.pipeline.create({
      data: {
        name: planned.name,
        description: planned.description,
        workflowId,
        steps: {
          create: planned.steps.map((step, index) => ({
            ...step,
            handlerConfig: step.handlerConfig as Prisma.InputJsonObject,
            stepOrder: index,
          })),
        },
      },
    });
    return { id: pipeline.id, fingerprint: stepsFingerprint(planned.steps) };
  }

  /**
   * Update a pipeline's steps in place, position by position, so the steps that stay keep
   * their run history; extra old steps are removed.
   */
  private async replaceSteps(tx: Tx, pipelineId: string, planned: PlannedPipeline) {
    await tx.pipeline.update({
      where: { id: pipelineId },
      data: { name: planned.name, description: planned.description },
    });
    const current = await tx.pipelineStep.findMany({
      where: { pipelineId },
      orderBy: { stepOrder: "asc" },
      select: { id: true },
    });
    // Step order is unique per pipeline: move the old steps out of the way first
    await tx.pipelineStep.updateMany({
      where: { pipelineId },
      data: { stepOrder: { increment: 10_000 } },
    });
    for (const [index, step] of planned.steps.entries()) {
      const data = {
        name: step.name,
        handlerKey: step.handlerKey,
        handlerConfig: step.handlerConfig as Prisma.InputJsonObject,
        stepOrder: index,
      };
      const reuse = current[index];
      if (reuse) {
        await tx.pipelineStep.update({ where: { id: reuse.id }, data });
      } else {
        await tx.pipelineStep.create({ data: { ...data, pipelineId } });
      }
    }
    const surplus = current.slice(planned.steps.length).map((s) => s.id);
    if (surplus.length > 0) {
      await tx.pipelineStep.deleteMany({ where: { id: { in: surplus } } });
    }
    return { id: pipelineId, fingerprint: stepsFingerprint(planned.steps) };
  }

  /**
   * A pipeline the parameters no longer need: deleted if it never ran, otherwise taken out
   * of the workflow and switched off so its run history stays.
   */
  private async retirePipeline(tx: Tx, pipelineId: string) {
    const [runs, startedBy] = await Promise.all([
      tx.pipelineExecution.count({ where: { pipelineId } }),
      // Connectors added by hand that start it would block deleting it
      tx.pipelineConnector.count({
        where: { OR: [{ targetPipelineId: pipelineId }, { otherwisePipelineId: pipelineId }] },
      }),
    ]);
    if (runs === 0 && startedBy === 0) {
      await tx.pipeline.delete({ where: { id: pipelineId } });
      return;
    }
    const pipeline = await tx.pipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    await tx.pipeline.update({
      where: { id: pipelineId },
      data: {
        workflowId: null,
        isActive: false,
        name: `${pipeline.name} (removed ${pipelineId.slice(0, 8)})`,
      },
    });
  }

  private async joinStillFits(tx: Tx, previous: TemplateState, plan: TemplatePlan) {
    const join = previous.join;
    if (!join || join.kind !== plan.join.kind) return false;
    // Same kind joins the same roles; it fits as long as those pipelines are kept
    const roles: PipelineRole[] =
      plan.join.kind === "merge"
        ? [...plan.join.sources, plan.join.target]
        : [plan.join.source, plan.join.target];
    if (roles.some((role) => !previous.pipelines[role])) return false;
    const found =
      join.kind === "merge"
        ? await tx.pipelineMerge.count({ where: { id: join.id } })
        : await tx.pipelineConnector.count({ where: { id: join.id } });
    return found > 0;
  }

  private async deleteJoin(tx: Tx, join: TemplateState["join"]) {
    if (!join) return;
    if (join.kind === "merge") {
      await tx.pipelineMerge.deleteMany({ where: { id: join.id } });
    } else {
      await tx.pipelineConnector.deleteMany({ where: { id: join.id } });
    }
  }

  private async createJoin(
    tx: Tx,
    workflowId: string,
    plan: TemplatePlan,
    state: TemplateState
  ): Promise<TemplateState["join"]> {
    const idOf = (role: PipelineRole) => state.pipelines[role]!.id;
    const join = plan.join;
    if (join.kind === "merge") {
      const merge = await tx.pipelineMerge.create({
        data: {
          name: `${plan.workflow.name}: data ready`,
          workflowId,
          targetPipelineId: idOf(join.target),
          triggerRule: MergeTriggerRule.ALL_SUCCEEDED,
          timeoutMinutes: MERGE_TIMEOUT_MINUTES,
          sources: { create: join.sources.map((role) => ({ pipelineId: idOf(role) })) },
        },
      });
      return { kind: "merge", id: merge.id };
    }
    const connector = await tx.pipelineConnector.create({
      data: {
        name: `${plan.workflow.name}: data ready`,
        sourcePipelineId: idOf(join.source),
        targetPipelineId: idOf(join.target),
      },
    });
    return { kind: "connector", id: connector.id };
  }
}
