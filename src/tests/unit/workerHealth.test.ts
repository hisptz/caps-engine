import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHealth, startHealthBeat } from "@/services/worker/utils/health.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-health-"));
  file = join(dir, "health");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkHealth", () => {
  it("is unhealthy when the worker never wrote the file", () => {
    expect(checkHealth(file)).toBe(1);
  });

  it("is healthy when the last beat is recent", () => {
    writeFileSync(file, String(Date.now() - 5_000));
    expect(checkHealth(file)).toBe(0);
  });

  it("is unhealthy when the last beat is stale", () => {
    writeFileSync(file, String(Date.now() - 60_000));
    expect(checkHealth(file)).toBe(1);
  });

  it("is unhealthy when the file is garbage", () => {
    writeFileSync(file, "not-a-timestamp");
    expect(checkHealth(file)).toBe(1);
  });
});

describe("startHealthBeat", () => {
  it("writes beats only while connected, so a disconnect goes stale", () => {
    vi.useFakeTimers();
    let connected = true;
    const timer = startHealthBeat(() => connected, file);
    expect(checkHealth(file)).toBe(0);

    connected = false;
    vi.advanceTimersByTime(40_000);
    expect(checkHealth(file, Date.now())).toBe(1);

    connected = true;
    vi.advanceTimersByTime(10_000);
    expect(checkHealth(file, Date.now())).toBe(0);
    clearInterval(timer);
  });

  it("does not create the file while disconnected", () => {
    const timer = startHealthBeat(() => false, file);
    expect(existsSync(file)).toBe(false);
    clearInterval(timer);
  });
});
