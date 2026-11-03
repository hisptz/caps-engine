import type { PullItem } from "@/services/worker/services/handlers/dhis2InstancePull/schemas/config.ts";

/** PULL: instance → staging. PUSH: staging → instance. */
export type MappingDirectionValue = "PULL" | "PUSH";

/** One mapping of a connected instance: a remote item, a staging data element, a direction. */
export type InstanceMapping = {
  remoteItem: string;
  remoteItemType: PullItem["fromType"];
  stagingDataElement: string;
  direction: MappingDirectionValue;
};

/**
 * Problems inside one list of mappings: a remote item or staging data element paired twice,
 * or a push into something that isn't a data element (indicators can't receive values).
 */
export function findMappingProblems(mappings: InstanceMapping[]): string[] {
  const problems: string[] = [];
  const remote = new Set<string>();
  const staging = new Set<string>();
  for (const mapping of mappings) {
    if (remote.has(mapping.remoteItem)) {
      problems.push(`${mapping.remoteItem} is mapped more than once`);
    }
    if (staging.has(mapping.stagingDataElement)) {
      problems.push(`${mapping.stagingDataElement} is mapped more than once`);
    }
    if (mapping.direction === "PUSH" && mapping.remoteItemType !== "DATA_ELEMENT") {
      problems.push(`${mapping.remoteItem} can't receive pushed values: it isn't a data element`);
    }
    remote.add(mapping.remoteItem);
    staging.add(mapping.stagingDataElement);
  }
  return problems;
}

/** A staging data element another instance already pulls into. */
export type TakenStagingDataElement = {
  stagingDataElement: string;
  routeCode: string;
  remoteItem: string;
};

/** Staging data elements `mappings` would pull into that another instance already pulls into. */
export function findTakenStagingDataElements(
  routeCode: string,
  mappings: InstanceMapping[],
  existing: Array<InstanceMapping & { routeCode: string }>
): TakenStagingDataElement[] {
  const pulledBy = new Map(
    existing
      .filter((row) => row.direction === "PULL" && row.routeCode !== routeCode)
      .map((row) => [row.stagingDataElement, row])
  );
  return mappings.flatMap((mapping) => {
    const row = mapping.direction === "PULL" ? pulledBy.get(mapping.stagingDataElement) : undefined;
    return row
      ? [
          {
            stagingDataElement: mapping.stagingDataElement,
            routeCode: row.routeCode,
            remoteItem: row.remoteItem,
          },
        ]
      : [];
  });
}

export type MappedStep = {
  stepId: string;
  stepName: string;
  pipelineName: string;
  direction: MappingDirectionValue;
  mapped: string[];
};

/** Steps that move a staging data element the new mappings no longer pair their way. */
export function findStepsLosingMappings(
  steps: MappedStep[],
  mappings: Pick<InstanceMapping, "stagingDataElement" | "direction">[]
): Array<MappedStep & { missing: string[] }> {
  const directions = new Map(mappings.map((m) => [m.stagingDataElement, m.direction]));
  return steps.flatMap((step) => {
    const missing = step.mapped.filter((id) => directions.get(id) !== step.direction);
    return missing.length > 0 ? [{ ...step, missing }] : [];
  });
}

/** The org unit match most of the instance's steps use, for an instance without settings yet. */
export function suggestOrgUnitMatch(values: unknown[]): "id" | "code" {
  const code = values.filter((value) => value === "code").length;
  return code > values.length - code ? "code" : "id";
}
