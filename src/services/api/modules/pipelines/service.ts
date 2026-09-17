import { Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { PipelineQueries, ActiveExecutionError } from "@/services/api/utils/pipeline/queries.ts";
import { validateStepHandlerInput } from "@/services/api/utils/pipeline/stepValidation.ts";
import { validatePipelineInputContext } from "@/services/api/utils/pipeline/inputContextValidation.ts";
import { ApiError, conflict, notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import type {
  ListPipelinesQuery,
  CreatePipelineBody,
  UpdatePipelineBody,
  CreateStepBody,
  UpdateStepBody,
  CreateScheduleBody,
} from "@/services/api/modules/pipelines/model.ts";

function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

function isPrismaDuplicate(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export class PipelineService {
  private _queries?: PipelineQueries;
  // `apiDb` is assigned by initializeApiDb() after this module is imported, so the query
  // instance must be constructed lazily on first use rather than at class-field-init time.
  private get queries(): PipelineQueries {
    return (this._queries ??= new PipelineQueries(apiDb));
  }

  async listPipelines(query: ListPipelinesQuery) {
    return this.queries.listPipelines(query);
  }

  async createPipeline(body: CreatePipelineBody) {
    try {
      return await this.queries.createPipeline(body);
    } catch (err) {
      if (isPrismaDuplicate(err)) {
        throw conflict(
          "A pipeline with that name already exists",
          ApiErrorCode.PIPELINE_DUPLICATE_NAME
        );
      }
      throw err;
    }
  }

  async getPipeline(id: string) {
    try {
      return await this.queries.getPipeline(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }

  async updatePipeline(id: string, body: UpdatePipelineBody) {
    try {
      return await this.queries.updatePipeline(id, body);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      if (isPrismaDuplicate(err)) {
        throw conflict(
          "A pipeline with that name already exists",
          ApiErrorCode.PIPELINE_DUPLICATE_NAME
        );
      }
      throw err;
    }
  }

  async deletePipeline(id: string) {
    try {
      return await this.queries.deletePipeline(id);
    } catch (err) {
      if (err instanceof ActiveExecutionError) {
        throw conflict(err.message, ApiErrorCode.PIPELINE_HAS_ACTIVE_EXECUTIONS);
      }
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }

  async listSteps(id: string) {
    try {
      return await this.queries.listSteps(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }

  async createStep(id: string, body: CreateStepBody) {
    const validation = validateStepHandlerInput({
      handlerKey: body.handlerKey,
      handlerConfig: body.handlerConfig,
    });
    if (validation instanceof ApiError) {
      throw validation;
    }

    try {
      return await this.queries.createStep(id, {
        ...body,
        handlerKey: validation.handlerKey,
        handlerConfig: validation.handlerConfig,
      });
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      if (isPrismaDuplicate(err)) {
        throw conflict(
          "stepOrder is already taken for this pipeline",
          ApiErrorCode.STEP_ORDER_TAKEN
        );
      }
      throw err;
    }
  }

  async updateStep(stepId: string, body: UpdateStepBody) {
    if (body.handlerKey !== undefined || body.handlerConfig !== undefined) {
      const existing = await this.queries.getStep(stepId);
      const validation = validateStepHandlerInput({
        handlerKey: body.handlerKey ?? existing.handlerKey,
        handlerConfig:
          body.handlerConfig ?? (existing.handlerConfig as Record<string, unknown> | undefined),
      });
      if (validation instanceof ApiError) {
        throw validation;
      }
    }

    try {
      return await this.queries.updateStep(stepId, body);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Step not found", ApiErrorCode.STEP_NOT_FOUND);
      }
      if (isPrismaDuplicate(err)) {
        throw conflict(
          "stepOrder is already taken for this pipeline",
          ApiErrorCode.STEP_ORDER_TAKEN
        );
      }
      throw err;
    }
  }

  async deleteStep(stepId: string) {
    try {
      return await this.queries.deleteStep(stepId);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Step not found", ApiErrorCode.STEP_NOT_FOUND);
      }
      throw err;
    }
  }

  async listSchedules(id: string) {
    try {
      return await this.queries.listSchedules(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }

  async createSchedule(id: string, body: CreateScheduleBody) {
    const contextError = await validatePipelineInputContext(this.queries, id, body.inputContext);
    if (contextError) {
      throw contextError;
    }

    try {
      return await this.queries.createSchedule(id, {
        name: body.name,
        description: body.description,
        cronExpr: body.cronExpr,
        inputContext: body.inputContext,
      });
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
      }
      throw err;
    }
  }
}
