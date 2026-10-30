import { ConnectorRunStatus, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { conflict, notFound } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { findConnectorCycle, type ConnectorEdge } from "@/shared/pipeline/connectors.ts";
import type {
  CreateConnectorBody,
  ListConnectorRunsQuery,
  ListConnectorsQuery,
  UpdateConnectorBody,
} from "@/services/api/modules/connectors/model.ts";

function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

const pipelineRef = { select: { id: true, name: true, isActive: true } } as const;

const connectorInclude = {
  sourcePipeline: pipelineRef,
  targetPipeline: pipelineRef,
  _count: { select: { runs: true } },
  // The latest decision, so a list can show whether the connector last started its target
  runs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      reason: true,
      checkAt: true,
      evaluatedAt: true,
      createdAt: true,
      targetExecution: { select: { id: true, status: true } },
    },
  },
} as const;

/** A null rule is stored as SQL NULL; undefined leaves the column untouched. */
function toConditionInput(
  condition: unknown
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (condition === undefined) return undefined;
  if (condition === null) return Prisma.DbNull;
  return condition as Prisma.InputJsonValue;
}

export class ConnectorService {
  async listConnectors(query: ListConnectorsQuery) {
    return apiDb.pipelineConnector.findMany({
      where: query.pipelineId
        ? {
            OR: [{ sourcePipelineId: query.pipelineId }, { targetPipelineId: query.pipelineId }],
          }
        : undefined,
      include: connectorInclude,
      orderBy: { createdAt: "asc" },
    });
  }

  async getConnector(id: string) {
    const connector = await apiDb.pipelineConnector.findUnique({
      where: { id },
      include: connectorInclude,
    });
    if (!connector) {
      throw notFound("Connector not found", ApiErrorCode.CONNECTOR_NOT_FOUND);
    }
    return connector;
  }

  async createConnector(body: CreateConnectorBody) {
    await this.assertPipelinesExist([body.sourcePipelineId, body.targetPipelineId]);
    if (body.isActive) {
      await this.assertNoCycle({
        sourcePipelineId: body.sourcePipelineId,
        targetPipelineId: body.targetPipelineId,
      });
    }

    return apiDb.pipelineConnector.create({
      data: {
        name: body.name,
        description: body.description,
        sourcePipelineId: body.sourcePipelineId,
        targetPipelineId: body.targetPipelineId,
        on: body.on,
        condition: toConditionInput(body.condition),
        inputMapping: body.inputMapping,
        delayMinutes: body.delayMinutes,
        isActive: body.isActive,
      },
      include: connectorInclude,
    });
  }

  async updateConnector(id: string, body: UpdateConnectorBody) {
    const existing = await this.getConnector(id);
    const targetPipelineId = body.targetPipelineId ?? existing.targetPipelineId;
    const isActive = body.isActive ?? existing.isActive;

    if (body.targetPipelineId !== undefined) {
      await this.assertPipelinesExist([body.targetPipelineId]);
    }
    // Re-check only when the graph of active connectors actually changes
    const graphChanges =
      targetPipelineId !== existing.targetPipelineId || (isActive && !existing.isActive);
    if (isActive && graphChanges) {
      await this.assertNoCycle(
        { sourcePipelineId: existing.sourcePipelineId, targetPipelineId },
        id
      );
    }

    try {
      return await apiDb.pipelineConnector.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          targetPipelineId: body.targetPipelineId,
          on: body.on,
          condition: toConditionInput(body.condition),
          inputMapping: body.inputMapping,
          delayMinutes: body.delayMinutes,
          isActive: body.isActive,
        },
        include: connectorInclude,
      });
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Connector not found", ApiErrorCode.CONNECTOR_NOT_FOUND);
      }
      throw err;
    }
  }

  async deleteConnector(id: string) {
    try {
      return await apiDb.pipelineConnector.delete({ where: { id } });
    } catch (err) {
      if (isPrismaNotFound(err)) {
        throw notFound("Connector not found", ApiErrorCode.CONNECTOR_NOT_FOUND);
      }
      throw err;
    }
  }

  async listConnectorRuns(connectorId: string, query: ListConnectorRunsQuery) {
    await this.getConnector(connectorId);
    const where: Prisma.ConnectorRunWhereInput = { connectorId, status: query.status };
    const [items, total] = await Promise.all([
      apiDb.connectorRun.findMany({
        where,
        include: {
          sourceExecution: { select: { id: true, status: true, finishedAt: true } },
          targetExecution: { select: { id: true, status: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      apiDb.connectorRun.count({ where }),
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

  /** Stop a connector run that has not been decided yet (e.g. still in its delay). */
  async cancelConnectorRun(id: string) {
    const run = await apiDb.connectorRun.findUnique({ where: { id }, select: { status: true } });
    if (!run) {
      throw notFound("Connector run not found", ApiErrorCode.CONNECTOR_RUN_NOT_FOUND);
    }
    const updated = await apiDb.connectorRun.updateMany({
      where: { id, status: ConnectorRunStatus.WAITING },
      data: {
        status: ConnectorRunStatus.CANCELLED,
        reason: "Cancelled via API",
        evaluatedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw conflict(
        `Connector run is already ${run.status.toLowerCase()}`,
        ApiErrorCode.CONNECTOR_RUN_INVALID_STATE
      );
    }
    return { connectorRunId: id, status: ConnectorRunStatus.CANCELLED };
  }

  private async assertPipelinesExist(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await apiDb.pipeline.count({ where: { id: { in: unique } } });
    if (found !== unique.length) {
      throw notFound("Pipeline not found", ApiErrorCode.PIPELINE_NOT_FOUND);
    }
  }

  private async assertNoCycle(edge: ConnectorEdge, excludeConnectorId?: string) {
    const existing = await apiDb.pipelineConnector.findMany({
      where: { isActive: true, ...(excludeConnectorId ? { id: { not: excludeConnectorId } } : {}) },
      select: { sourcePipelineId: true, targetPipelineId: true },
    });
    const cycle = findConnectorCycle(existing, edge);
    if (!cycle) return;

    const pipelines = await apiDb.pipeline.findMany({
      where: { id: { in: cycle } },
      select: { id: true, name: true },
    });
    const names = new Map(pipelines.map((p) => [p.id, p.name]));
    const path = cycle.map((id) => names.get(id) ?? id).join(" → ");
    throw conflict(`Connector would create a loop: ${path}`, ApiErrorCode.CONNECTOR_CREATES_CYCLE, {
      pipelineIds: cycle,
    });
  }
}
