import { OrgUnitMatch, Prisma } from "@db/client";
import { apiDb } from "@/services/api/utils/db.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import { badRequest, conflict } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import {
  findMappingProblems,
  findStepsLosingMappings,
  findTakenStagingDataElements,
  suggestOrgUnitMatch,
  type InstanceMapping,
  type MappedStep,
  type MappingDirectionValue,
} from "@/shared/mappings/instanceMappings.ts";
import type { PutInstanceBody } from "@/services/api/modules/instances/model.ts";

const mappingSelect = {
  remoteItem: true,
  remoteItemType: true,
  stagingDataElement: true,
  direction: true,
} as const;

const STEP_DIRECTIONS = new Map<string, MappingDirectionValue>([
  [Handlers.DHIS2_INSTANCE_PULL, "PULL"],
  [Handlers.DHIS2_INSTANCE_PUSH, "PUSH"],
]);

const toOrgUnitMatch = (value: "id" | "code") =>
  value === "code" ? OrgUnitMatch.CODE : OrgUnitMatch.ID;
const fromOrgUnitMatch = (value: OrgUnitMatch) => (value === OrgUnitMatch.CODE ? "code" : "id");

/** The row to write for a mapping of this instance; `pullTarget` holds the one-source rule. */
const toRow = (routeCode: string, mapping: InstanceMapping) => ({
  ...mapping,
  routeCode,
  pullTarget: mapping.direction === "PULL" ? mapping.stagingDataElement : null,
});

type InstanceStep = {
  stepId: string;
  stepName: string;
  handlerKey: string;
  direction: MappingDirectionValue;
  pipelineId: string;
  pipelineName: string;
  /** Steps of template workflows are left alone: their pipelines are rebuilt from parameters. */
  fromTemplate: boolean;
  config: Record<string, unknown>;
};

/** Pull and push steps that go through this instance's route. */
async function findInstanceSteps(
  routeCode: string,
  db: Prisma.TransactionClient = apiDb
): Promise<InstanceStep[]> {
  const steps = await db.pipelineStep.findMany({
    where: {
      handlerKey: { in: [...STEP_DIRECTIONS.keys()] },
      handlerConfig: { path: ["routeCode"], equals: routeCode },
    },
    select: {
      id: true,
      name: true,
      handlerKey: true,
      handlerConfig: true,
      pipeline: { select: { id: true, name: true, workflow: { select: { template: true } } } },
    },
    orderBy: [{ pipeline: { name: "asc" } }, { stepOrder: "asc" }],
  });
  return steps.map((step) => ({
    stepId: step.id,
    stepName: step.name,
    handlerKey: step.handlerKey,
    direction: STEP_DIRECTIONS.get(step.handlerKey)!,
    pipelineId: step.pipeline.id,
    pipelineName: step.pipeline.name,
    fromTemplate: Boolean(step.pipeline.workflow?.template),
    config: step.handlerConfig as Record<string, unknown>,
  }));
}

function mappedSteps(steps: InstanceStep[]): MappedStep[] {
  return steps.flatMap((step) =>
    Array.isArray(step.config.mapped)
      ? [
          {
            stepId: step.stepId,
            stepName: step.stepName,
            pipelineName: step.pipelineName,
            direction: step.direction,
            mapped: step.config.mapped as string[],
          },
        ]
      : []
  );
}

export class InstanceService {
  /** Every configured instance with its number of mappings. */
  async listInstances() {
    const instances = await apiDb.connectedInstance.findMany({
      include: { _count: { select: { mappings: true } } },
      orderBy: { routeCode: "asc" },
    });
    return instances.map((instance) => ({
      routeCode: instance.routeCode,
      orgUnitMatch: fromOrgUnitMatch(instance.orgUnitMatch),
      mappings: instance._count.mappings,
      updatedAt: instance.updatedAt,
    }));
  }

  /**
   * An instance's settings and mappings, with the steps that use it. An instance without
   * settings yet answers with `configured: false` and the org unit match its steps use most.
   */
  async getInstance(routeCode: string) {
    const [instance, steps] = await Promise.all([
      apiDb.connectedInstance.findUnique({
        where: { routeCode },
        include: { mappings: { select: mappingSelect, orderBy: { createdAt: "asc" } } },
      }),
      findInstanceSteps(routeCode),
    ]);
    return {
      routeCode,
      configured: instance !== null,
      orgUnitMatch: instance
        ? fromOrgUnitMatch(instance.orgUnitMatch)
        : suggestOrgUnitMatch(steps.map((step) => step.config.orgUnitMatch)),
      mappings: instance?.mappings ?? [],
      steps: steps.map((step) => ({
        stepId: step.stepId,
        stepName: step.stepName,
        handlerKey: step.handlerKey,
        direction: step.direction,
        pipelineId: step.pipelineId,
        pipelineName: step.pipelineName,
        fromTemplate: step.fromTemplate,
        mapped: Array.isArray(step.config.mapped) ? step.config.mapped : null,
        /** Older steps that still list their own items. */
        legacyItems: Array.isArray(step.config.items) ? step.config.items.length : null,
      })),
    };
  }

  /**
   * Replaces the instance's settings and mappings. Refused when another instance already pulls
   * into a staging data element this one would pull into, or when a step still moves a
   * mapping that is removed or no longer goes its way.
   */
  async putInstance(routeCode: string, body: PutInstanceBody) {
    const problems = findMappingProblems(body.mappings);
    if (problems.length > 0) {
      throw badRequest("Some mappings are invalid", ApiErrorCode.INSTANCE_MAPPING_INVALID, {
        problems,
      });
    }

    await apiDb.$transaction(
      async (tx) => {
        const others = await tx.instanceMapping.findMany({
          where: {
            pullTarget: { in: body.mappings.map((m) => m.stagingDataElement) },
            NOT: { routeCode },
          },
        });
        const taken = findTakenStagingDataElements(routeCode, body.mappings, others);
        if (taken.length > 0) {
          throw conflict(
            "Some staging data elements are already fed by another source",
            ApiErrorCode.INSTANCE_MAPPING_CONFLICT,
            { taken }
          );
        }

        const losing = findStepsLosingMappings(
          mappedSteps(await findInstanceSteps(routeCode, tx)),
          body.mappings
        );
        if (losing.length > 0) {
          throw conflict(
            "Some mappings are still used by pipeline steps",
            ApiErrorCode.INSTANCE_MAPPING_IN_USE,
            { steps: losing }
          );
        }

        const orgUnitMatch = toOrgUnitMatch(body.orgUnitMatch);
        await tx.connectedInstance.upsert({
          where: { routeCode },
          create: { routeCode, orgUnitMatch },
          update: { orgUnitMatch },
        });
        await tx.instanceMapping.deleteMany({ where: { routeCode } });
        await tx.instanceMapping.createMany({
          data: body.mappings.map((mapping) => toRow(routeCode, mapping)),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return this.getInstance(routeCode);
  }

  /** Forgets the instance's settings and mappings, e.g. when its route is deleted. */
  async deleteInstance(routeCode: string) {
    const { count } = await apiDb.instanceMapping.deleteMany({ where: { routeCode } });
    await apiDb.connectedInstance.deleteMany({ where: { routeCode } });
    return { routeCode, removedMappings: count };
  }

  /** Every mapping of every instance, for pickers that warn about taken staging data elements. */
  async listMappings() {
    return apiDb.instanceMapping.findMany({
      select: { ...mappingSelect, routeCode: true },
      orderBy: { stagingDataElement: "asc" },
    });
  }
}
