import { OrgUnitMatch, type PrismaClient } from "@db/client.ts";
import { Handlers } from "@/services/worker/constants/handlers.ts";
import type { MappingDirectionValue } from "@/shared/mappings/instanceMappings.ts";
import { StepError } from "@/shared/utils/error.ts";

type MappingDb = Pick<PrismaClient, "connectedInstance">;

const STEP_DIRECTIONS = new Map<string, MappingDirectionValue>([
  [Handlers.DHIS2_INSTANCE_PULL, "PULL"],
  [Handlers.DHIS2_INSTANCE_PUSH, "PUSH"],
]);

/**
 * Fills in what a pull or push step takes from its connected instance, after the effective
 * config is resolved and validated:
 *   - `orgUnitMatch` from the instance's settings, when it has any (the step's own value
 *     otherwise, for instances set up before settings existed);
 *   - for steps that name `mapped` staging data elements, the `items` the handler runs, from
 *     the instance's mappings in the step's direction. A data element no longer mapped that way
 *     fails the step rather than being skipped, so a run never quietly moves less than it says.
 * Other handlers' configs are returned as they are.
 */
export async function resolveInstanceMappings(
  db: MappingDb,
  handlerKey: string,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const direction = STEP_DIRECTIONS.get(handlerKey);
  if (!direction || typeof config.routeCode !== "string") {
    return config;
  }
  const routeCode = config.routeCode;
  const mapped = Array.isArray(config.mapped) ? (config.mapped as string[]) : undefined;
  const instance = await db.connectedInstance.findUnique({
    where: { routeCode },
    include: { mappings: { where: { stagingDataElement: { in: mapped ?? [] } } } },
  });

  const resolved: Record<string, unknown> = { ...config };
  if (instance) {
    resolved.orgUnitMatch = instance.orgUnitMatch === OrgUnitMatch.CODE ? "code" : "id";
  }
  if (!mapped) {
    return resolved;
  }

  const mappings = new Map(
    (instance?.mappings ?? [])
      .filter((mapping) => mapping.direction === direction)
      .map((mapping) => [mapping.stagingDataElement, mapping])
  );
  const unmapped = mapped.filter((id) => !mappings.has(id));
  if (unmapped.length > 0) {
    throw new StepError(
      direction === "PULL"
        ? "Some data elements are no longer pulled from this instance"
        : "Some data elements are no longer pushed to this instance",
      {
        source: "caps",
        routeCode,
        dataElements: unmapped,
        description:
          "Map them again under Settings → Connected instances, or take them out of the step.",
      }
    );
  }
  resolved.items = mapped.map((id) => {
    const mapping = mappings.get(id)!;
    return direction === "PULL"
      ? { from: mapping.remoteItem, fromType: mapping.remoteItemType, into: id }
      : { from: id, into: mapping.remoteItem };
  });
  delete resolved.mapped;
  return resolved;
}
