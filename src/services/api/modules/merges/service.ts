import { MergeRunStatus, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { findPipelineLoop } from "@/services/api/utils/pipeline/graph.ts";
import { badRequest, conflict, notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import type {
  CreateMergeBody,
  ListMergeRunsQuery,
  ListMergesQuery,
  UpdateMergeBody,
} from "@/services/api/modules/merges/model.ts";

const pipelineRef = { select: { id: true, name: true, isActive: true } } as const;

const mergeInclude = {
  workflow: { select: { id: true, name: true } },
  targetPipeline: pipelineRef,
  // Steps too, so the app can name the step results a condition checks
  sources: {
    include: {
      pipeline: {
        select: {
          id: true,
          name: true,
          isActive: true,
          steps: { orderBy: { stepOrder: "asc" } },
        },
      },
    },
  },
  _count: { select: { runs: true } },
  // The latest decision, so a list can show whether the merge last started its target
  runs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      reason: true,
      deadlineAt: true,
      evaluatedAt: true,
      createdAt: true,
      targetExecution: { select: { id: true, status: true } },
    },
  },
} as const;

const mergeNotFound = () => notFound("Connector not found", ApiErrorCode.MERGE_NOT_FOUND);

/** A null rule is stored as SQL NULL; undefined leaves the column untouched. */
function toConditionInput(
  condition: unknown
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (condition === undefined) return undefined;
  if (condition === null) return Prisma.DbNull;
  return condition as Prisma.InputJsonValue;
}

export class MergeService {
  async listMerges(query: ListMergesQuery) {
    return apiDb.pipelineMerge.findMany({
      where: {
        ...(query.workflowId ? { workflowId: query.workflowId } : {}),
        ...(query.pipelineId
          ? {
              OR: [
                { targetPipelineId: query.pipelineId },
                { sources: { some: { pipelineId: query.pipelineId } } },
              ],
            }
          : {}),
      },
      include: mergeInclude,
      orderBy: { createdAt: "asc" },
    });
  }

  async getMerge(id: string) {
    const merge = await apiDb.pipelineMerge.findUnique({ where: { id }, include: mergeInclude });
    if (!merge) throw mergeNotFound();
    return merge;
  }

  async createMerge(body: CreateMergeBody) {
    await this.assertShape(body.workflowId, body.sourcePipelineIds, body.targetPipelineId);
    if (body.isActive) {
      await this.assertNoLoop(body.sourcePipelineIds, body.targetPipelineId);
    }
    const created = await apiDb.pipelineMerge.create({
      data: {
        name: body.name,
        description: body.description,
        workflowId: body.workflowId,
        targetPipelineId: body.targetPipelineId,
        triggerRule: body.triggerRule,
        timeoutMinutes: body.timeoutMinutes,
        condition: toConditionInput(body.condition),
        isActive: body.isActive,
        sources: { create: body.sourcePipelineIds.map((pipelineId) => ({ pipelineId })) },
      },
    });
    return this.getMerge(created.id);
  }

  async updateMerge(id: string, body: UpdateMergeBody) {
    const existing = await this.getMerge(id);
    const sourceIds = body.sourcePipelineIds ?? existing.sources.map((s) => s.pipelineId);
    const targetId = body.targetPipelineId ?? existing.targetPipelineId;
    const isActive = body.isActive ?? existing.isActive;

    await this.assertShape(existing.workflowId, sourceIds, targetId);
    const graphChanges =
      body.sourcePipelineIds !== undefined ||
      targetId !== existing.targetPipelineId ||
      (isActive && !existing.isActive);
    if (isActive && graphChanges) {
      await this.assertNoLoop(sourceIds, targetId, id);
    }

    await apiDb.$transaction(async (tx) => {
      await tx.pipelineMerge.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          targetPipelineId: body.targetPipelineId,
          triggerRule: body.triggerRule,
          timeoutMinutes: body.timeoutMinutes,
          condition: toConditionInput(body.condition),
          isActive: body.isActive,
        },
      });
      if (body.sourcePipelineIds) {
        await tx.mergeSource.deleteMany({ where: { mergeId: id } });
        await tx.mergeSource.createMany({
          data: body.sourcePipelineIds.map((pipelineId) => ({ mergeId: id, pipelineId })),
        });
      }
    });
    return this.getMerge(id);
  }

  async deleteMerge(id: string) {
    await this.getMerge(id);
    return apiDb.pipelineMerge.delete({ where: { id } });
  }

  async listMergeRuns(mergeId: string, query: ListMergeRunsQuery) {
    await this.getMerge(mergeId);
    const where: Prisma.MergeRunWhereInput = { mergeId, status: query.status };
    const [items, total] = await Promise.all([
      apiDb.mergeRun.findMany({
        where,
        include: {
          arrivals: {
            select: { pipelineId: true, executionId: true, status: true, createdAt: true },
          },
          targetExecution: { select: { id: true, status: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      apiDb.mergeRun.count({ where }),
    ]);
    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pages: Math.ceil(total / query.pageSize),
      },
    };
  }

  /** Stop a merge run that is still waiting for its sources. */
  async cancelMergeRun(id: string) {
    const run = await apiDb.mergeRun.findUnique({ where: { id }, select: { status: true } });
    if (!run) {
      throw notFound("Connector run not found", ApiErrorCode.MERGE_RUN_NOT_FOUND);
    }
    const updated = await apiDb.mergeRun.updateMany({
      where: { id, status: MergeRunStatus.WAITING },
      data: {
        status: MergeRunStatus.CANCELLED,
        reason: "Cancelled via API",
        evaluatedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw conflict(
        `Connector run is already ${run.status.toLowerCase()}`,
        ApiErrorCode.MERGE_RUN_INVALID_STATE
      );
    }
    return { mergeRunId: id, status: MergeRunStatus.CANCELLED };
  }

  /** Sources and target must be different pipelines of the merge's workflow. */
  private async assertShape(workflowId: string, sourceIds: string[], targetId: string) {
    if (sourceIds.includes(targetId)) {
      throw badRequest(
        "The pipeline to start cannot also be one the connector waits for",
        ApiErrorCode.MERGE_INVALID
      );
    }
    const workflow = await apiDb.workflow.findUnique({
      where: { id: workflowId },
      select: { id: true },
    });
    if (!workflow) {
      throw notFound("Workflow not found", ApiErrorCode.WORKFLOW_NOT_FOUND);
    }
    const ids = [...sourceIds, targetId];
    const members = await apiDb.pipeline.count({ where: { id: { in: ids }, workflowId } });
    if (members !== ids.length) {
      throw badRequest(
        "Every pipeline of a connector that waits for all must be in its workflow",
        ApiErrorCode.MERGE_INVALID
      );
    }
  }

  private async assertNoLoop(sourceIds: string[], targetId: string, excludeMergeId?: string) {
    const loop = await findPipelineLoop(
      apiDb,
      sourceIds.map((sourcePipelineId) => ({ sourcePipelineId, targetPipelineId: targetId })),
      { mergeId: excludeMergeId }
    );
    if (loop) {
      throw conflict(
        `Connector would create a loop: ${loop.path}`,
        ApiErrorCode.MERGE_CREATES_CYCLE,
        {
          pipelineIds: loop.pipelineIds,
        }
      );
    }
  }
}
