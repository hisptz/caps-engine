import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================
// Worker health check
// The distroless image has no shell or curl, so Docker's
// HEALTHCHECK runs `caps-worker --healthcheck`, which reads a
// timestamp the running worker refreshes while connected.
// A stale file means RabbitMQ is down or the worker is stuck.
// Keep this module free of app imports: the check runs it
// without loading (or validating the env of) the worker.
// ============================================================

export const HEALTHCHECK_FLAG = "--healthcheck";
export const HEALTH_FILE = join(tmpdir(), "caps-worker-health");

const BEAT_MS = 10_000;
const STALE_MS = 30_000;

/** Refreshes the health file every few seconds, but only while `isConnected()` holds. */
export function startHealthBeat(
  isConnected: () => boolean,
  file = HEALTH_FILE
): ReturnType<typeof setInterval> {
  const beat = () => {
    if (!isConnected()) return;
    try {
      writeFileSync(file, String(Date.now()));
    } catch {
      // A failed write leaves the file stale, which the check reports as unhealthy
    }
  };
  beat();
  return setInterval(beat, BEAT_MS);
}

/** Exit code for the Docker health check: 0 when the worker reported a live connection recently. */
export function checkHealth(file = HEALTH_FILE, now = Date.now()): 0 | 1 {
  try {
    const lastBeat = Number(readFileSync(file, "utf8"));
    return now - lastBeat < STALE_MS ? 0 : 1;
  } catch {
    return 1;
  }
}
