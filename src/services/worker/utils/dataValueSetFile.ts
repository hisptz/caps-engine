import { randomUUID } from "node:crypto";

/** Basename for a DataValueSet JSON file under OUTPUTS_DIR (unique per run). */
export function uniqueDataValueSetFilename(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "datavalueset";
  return `${safe}-${randomUUID()}.json`;
}
