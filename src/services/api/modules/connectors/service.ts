import { ConnectorRunStatus, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { badRequest, conflict, notFound } from "@/shared/api/errors.ts";
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
  otherwisePipeline: pipelineRef,
  _count: { select: { runs: true } },
  // The latest decision, so a list can show whether the connector last started its target
  runs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      startedOtherwise: true,
      reason: true,
      checkAt: true,
      evaluatedAt: true,
      createdAt: true,
      targetExecution: { select: { id: true, status: true } },
    },
  },
} as const;

/** Every pipeline a connector can start, for the loop check. */
function connectorEdges(connector: {
  sourcePipelineId: string;
  targetPipelineId: string;
  otherwisePipelineId: string | null;
}): ConnectorEdge[] {
  const targets = [connector.targetPipelineId, connector.otherwisePipelineId];
  return targets
    .filter((target): target is string => Boolean(target))
    .map((targetPipelineId) => ({
      sourcePipelineId: connector.sourcePipelineId,
      targetPipelineId,
    }));
}

/** An otherwise pipeline is a second, different target, and only makes sense behind a rule. */
function assertOtherwiseValid(connector: {
  targetPipelineId: string;
  otherwisePipelineId: string | null;
  condition: unknown;
}) {
  if (!connector.otherwisePipelineId) return;
  if (connector.otherwisePipelineId === connector.targetPipelineId) {
    throw badRequest(
      "The otherwise pipeline must differ from the target pipeline",
      ApiErrorCode.CONNECTOR_OTHERWISE_INVALID
    );
  }
  if (connector.condition === null || connector.condition === undefined) {
    throw badRequest(
      "An otherwise pipeline needs a condition; without one the target always starts",
      ApiErrorCode.CONNECTOR_OTHERWISE_INVALID
    );
  }
}

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
            OR: [
              { sourcePipelineId: query.pipelineId },
              { targetPipelineId: query.pipelineId },
              { otherwisePipelineId: query.pipelineId },
            ],
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
    const otherwisePipelineId = body.otherwisePipelineId ?? null;
    assertOtherwiseValid({
      targetPipelineId: body.targetPipelineId,
      otherwisePipelineId,
      condition: body.condition,
    });
    await this.assertPipelinesExist([
      body.sourcePipelineId,
      body.targetPipelineId,
      ...(otherwisePipelineId ? [otherwisePipelineId] : []),
    ]);
    if (body.isActive) {
      await this.assertNoCycle(
        connectorEdges({
          sourcePipelineId: body.sourcePipelineId,
          targetPipelineId: body.targetPipelineId,
          otherwisePipelineId,
        })
      );
    }

    return apiDb.pipelineConnector.create({
      data: {
        name: body.name,
        description: body.description,
        sourcePipelineId: body.sourcePipelineId,
        targetPipelineId: body.targetPipelineId,
        otherwisePipelineId,
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
    const otherwisePipelineId =
      body.otherwisePipelineId === undefined
        ? existing.otherwisePipelineId
        : body.otherwisePipelineId;
    const isActive = body.isActive ?? existing.isActive;
    assertOtherwiseValid({
      targetPipelineId,
      otherwisePipelineId,
      condition: body.condition === undefined ? existing.condition : body.condition,
    });

    const newPipelineIds = [body.targetPipelineId, body.otherwisePipelineId].filter(
      (pipelineId): pipelineId is string => typeof pipelineId === "string"
    );
    if (newPipelineIds.length > 0) {
      await this.assertPipelinesExist(newPipelineIds);
    }
    // Re-check only when the graph of active connectors actually changes
    const graphChanges =
      targetPipelineId !== existing.targetPipelineId ||
      otherwisePipelineId !== existing.otherwisePipelineId ||
      (isActive && !existing.isActive);
    if (isActive && graphChanges) {
      await this.assertNoCycle(
        connectorEdges({
          sourcePipelineId: existing.sourcePipelineId,
          targetPipelineId,
          otherwisePipelineId,
        }),
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
          otherwisePipelineId: body.otherwisePipelineId,
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

  private async assertNoCycle(edges: ConnectorEdge[], excludeConnectorId?: string) {
    const connectors = await apiDb.pipelineConnector.findMany({
      where: { isActive: true, ...(excludeConnectorId ? { id: { not: excludeConnectorId } } : {}) },
      select: { sourcePipelineId: true, targetPipelineId: true, otherwisePipelineId: true },
    });
    const existing = connectors.flatMap(connectorEdges);
    let cycle: string[] | null = null;
    for (const edge of edges) {
      cycle = findConnectorCycle(existing, edge);
      if (cycle) break;
      existing.push(edge);
    }
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
