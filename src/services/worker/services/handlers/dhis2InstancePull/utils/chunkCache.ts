import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Downloaded chunks kept on disk for one step of one execution, so a retry (automatic or
 * manual) downloads only the chunks an earlier attempt didn't finish.
 */
export type ChunkCache = {
  read(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
};

/** Stable key for a chunk request; the same request on a later attempt gets the same key. */
export function chunkKey(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
}

export function createChunkCache(dir: string): ChunkCache {
  const file = (key: string) => path.join(dir, `${key}.json`);
  return {
    async read(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
    async save(key, value) {
      await mkdir(dir, { recursive: true });
      // Write then rename, so a crash mid-write never leaves a half chunk to reuse.
      const tmp = `${file(key)}.tmp`;
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, file(key));
    },
    async clear() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Deletes chunk folders under `root` that haven't changed for `maxAgeMs`, left behind by runs
 * that failed and were never retried. Returns how many were deleted.
 */
export async function sweepOldChunkFolders(
  root: string,
  maxAgeMs: number,
  now = Date.now()
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    const info = await stat(dir).catch(() => undefined);
    if (info?.isDirectory() && now - info.mtimeMs > maxAgeMs) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
