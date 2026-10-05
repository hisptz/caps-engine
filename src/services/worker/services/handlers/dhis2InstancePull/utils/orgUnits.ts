import type { AxiosInstance } from "axios";

export type OrgUnitRow = {
  id: string;
  code?: string;
  /** DHIS2 date-times like "2016-10-01T00:00:00.000". */
  openingDate?: string;
  closedDate?: string;
};

const MAX_FILTER_CHARS = 5500;

/** Splits `values` into batches of at most `size` values and `MAX_FILTER_CHARS` characters. */
function filterBatches(values: string[], size: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const value of values) {
    if (batch.length > 0 && (batch.length >= size || chars + value.length + 1 > MAX_FILTER_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(value);
    chars += value.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Org units on `client` whose `field` is one of `values`. Values that would break an
 * `in:[a,b]` filter (commas, brackets; codes only) are looked up one at a time.
 */
async function findOrgUnits(
  client: AxiosInstance,
  field: "id" | "code",
  values: string[],
  batchSize: number
): Promise<OrgUnitRow[]> {
  const unsafe = (value: string) => /[,[\]]/.test(value);
  const filters = [
    ...filterBatches(
      values.filter((v) => !unsafe(v)),
      batchSize
    ).map((batch) => `${field}:in:[${batch.join(",")}]`),
    ...values.filter(unsafe).map((value) => `${field}:eq:${value}`),
  ];
  const found: OrgUnitRow[] = [];
  for (const filter of filters) {
    const response = await client.get<{ organisationUnits?: OrgUnitRow[] }>(
      "organisationUnits.json",
      { params: { filter, fields: "id,code,openingDate,closedDate", paging: "false" } }
    );
    found.push(...(response.data.organisationUnits ?? []));
  }
  return found;
}

export async function orgUnitsById(
  client: AxiosInstance,
  ids: string[],
  batchSize: number
): Promise<Map<string, OrgUnitRow>> {
  const units = await findOrgUnits(client, "id", ids, batchSize);
  return new Map(units.map((unit) => [unit.id, unit]));
}

export function isOpenForPeriod(unit: OrgUnitRow | undefined, periodStart: string): boolean {
  const opening = unit?.openingDate?.slice(0, 10);
  const closed = unit?.closedDate?.slice(0, 10);
  return (!opening || periodStart >= opening) && (!closed || periodStart <= closed);
}

export type MatchedOrgUnits = {
  stagingBySource: Map<string, string>;
  unmatched: string[];
};

/**
 * Finds the source org unit for each staging org unit: by the same ID, or, when `codes`
 * (staging ID → code) is given, by the same code. Staging org units without a code don't match.
 */
export async function matchOrgUnits(
  source: AxiosInstance,
  stagingIds: string[],
  batchSize: number,
  codes?: Map<string, string>
): Promise<MatchedOrgUnits> {
  const stagingBySource = new Map<string, string>();
  if (codes) {
    const onSource = await findOrgUnits(source, "code", [...new Set(codes.values())], batchSize);
    const sourceByCode = new Map(
      onSource.flatMap((unit) => (unit.code ? [[unit.code, unit.id] as const] : []))
    );
    for (const id of stagingIds) {
      const code = codes.get(id);
      const sourceId = code === undefined ? undefined : sourceByCode.get(code);
      if (sourceId) stagingBySource.set(sourceId, id);
    }
  } else {
    const onSource = await findOrgUnits(source, "id", stagingIds, batchSize);
    for (const { id } of onSource) stagingBySource.set(id, id);
  }
  const matched = new Set(stagingBySource.values());
  return { stagingBySource, unmatched: stagingIds.filter((id) => !matched.has(id)) };
}
