import { Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { PipelineQueries } from "@/services/api/utils/pipeline/queries.ts";
import { validatePipelineInputContext } from "@/services/api/utils/pipeline/inputContextValidation.ts";
import { notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import type { UpdateScheduleBody } from "@/services/api/modules/schedules/model.ts";

function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

export class ScheduleService {
  private _queries?: PipelineQueries;
  // `apiDb` is assigned by initializeApiDb() after this module is imported, so the query
  // instance must be constructed lazily on first use rather than at class-field-init time.
  private get queries(): PipelineQueries {
    return (this._queries ??= new PipelineQueries(apiDb));
  }

  async getSchedule(id: string) {
    try {
      return await this.queries.getSchedule(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Schedule not found", ApiErrorCode.SCHEDULE_NOT_FOUND);
      }
      throw err;
    }
  }

  async updateSchedule(id: string, body: UpdateScheduleBody) {
    try {
      if (body.inputContext !== undefined) {
        const existing = await this.queries.getSchedule(id);
        const contextError = await validatePipelineInputContext(
          this.queries,
          existing.pipelineId,
          body.inputContext
        );
        if (contextError) {
          throw contextError;
        }
      }
      return await this.queries.updateSchedule(id, body);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Schedule not found", ApiErrorCode.SCHEDULE_NOT_FOUND);
      }
      throw err;
    }
  }

  async deleteSchedule(id: string) {
    try {
      return await this.queries.deleteSchedule(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Schedule not found", ApiErrorCode.SCHEDULE_NOT_FOUND);
      }
      throw err;
    }
  }

  async pauseSchedule(id: string) {
    try {
      return await this.queries.pauseSchedule(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Schedule not found", ApiErrorCode.SCHEDULE_NOT_FOUND);
      }
      throw err;
    }
  }

  async resumeSchedule(id: string) {
    try {
      return await this.queries.resumeSchedule(id);
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Schedule not found", ApiErrorCode.SCHEDULE_NOT_FOUND);
      }
      throw err;
    }
  }
}
