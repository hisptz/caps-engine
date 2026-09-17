import type { StepContext } from "@/services/worker/types/service.ts";
import { getOrgUnitsByGroup, getOrgUnitsByLevels } from "@/services/worker/utils/dhis2.ts";
import { type OrgUnitConfigInput } from "@/services/worker/schemas/orgUnit.ts";

export async function resolveOrgUnitIds(orgUnit: OrgUnitConfigInput): Promise<string[]> {
  const orgUnitIds = new Set<string>();

  if (orgUnit.ids) {
    for (const id of orgUnit.ids) {
      orgUnitIds.add(id);
    }
  }

  if (orgUnit.levels && orgUnit.levels.length > 0) {
    const fromLevels = await getOrgUnitsByLevels(orgUnit.levels);
    for (const id of fromLevels) {
      orgUnitIds.add(id);
    }
  }

  if (orgUnit.groups) {
    for (const groupId of orgUnit.groups) {
      const fromGroup = await getOrgUnitsByGroup(groupId);
      for (const id of fromGroup) {
        orgUnitIds.add(id);
      }
    }
  }

  if (orgUnitIds.size === 0) {
    throw new Error("No org units found for the specified selection");
  }

  return [...orgUnitIds];
}

export async function resolveOrgUnitsWithTask(
  ctx: StepContext,
  orgUnit: OrgUnitConfigInput
): Promise<string[]> {
  const task = await ctx.tasks.startTask("resolve-org-units", { orgUnit });

  try {
    const orgUnitIds = await resolveOrgUnitIds(orgUnit);
    await task.succeed({ count: orgUnitIds.length });
    await ctx.log("INFO", "Resolved org units", { count: orgUnitIds.length });
    return orgUnitIds;
  } catch (err) {
    await task.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
