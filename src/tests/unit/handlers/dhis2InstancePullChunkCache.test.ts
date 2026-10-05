import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunkKey,
  createChunkCache,
  sweepOldChunkFolders,
} from "@/services/worker/services/handlers/dhis2InstancePull/utils/chunkCache.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chunk-cache-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("chunkKey", () => {
  it("is the same for the same request and differs for another", () => {
    const request = { dx: ["a"], pe: ["202601"], ou: ["x"] };
    expect(chunkKey(request)).toBe(chunkKey({ ...request }));
    expect(chunkKey(request)).not.toBe(chunkKey({ ...request, pe: ["202602"] }));
  });
});

describe("createChunkCache", () => {
  it("reads back a saved chunk, and nothing for an unsaved one", async () => {
    const cache = createChunkCache(path.join(root, "step"));
    await cache.save("k1", { dataValues: [{ value: "1" }] });
    expect(await cache.read("k1")).toEqual({ dataValues: [{ value: "1" }] });
    expect(await cache.read("k2")).toBeUndefined();
  });

  it("ignores a chunk file that isn't valid JSON", async () => {
    const dir = path.join(root, "step");
    const cache = createChunkCache(dir);
    await cache.save("k1", {});
    await writeFile(path.join(dir, "k1.json"), '{"dataValues": [');
    expect(await cache.read("k1")).toBeUndefined();
  });

  it("leaves no temporary files and removes everything on clear", async () => {
    const dir = path.join(root, "step");
    const cache = createChunkCache(dir);
    await cache.save("k1", {});
    expect(await readdir(dir)).toEqual(["k1.json"]);
    await cache.clear();
    await expect(readdir(dir)).rejects.toThrow();
    await cache.clear();
  });
});

describe("sweepOldChunkFolders", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("deletes folders older than the limit and keeps recent ones", async () => {
    const now = Date.now();
    await mkdir(path.join(root, "old"));
    await mkdir(path.join(root, "recent"));
    const eightDaysAgo = new Date(now - 8 * DAY);
    await utimes(path.join(root, "old"), eightDaysAgo, eightDaysAgo);

    expect(await sweepOldChunkFolders(root, 7 * DAY, now)).toBe(1);
    expect(await readdir(root)).toEqual(["recent"]);
  });

  it("does nothing when the folder doesn't exist yet", async () => {
    expect(await sweepOldChunkFolders(path.join(root, "missing"), DAY)).toBe(0);
  });
});
