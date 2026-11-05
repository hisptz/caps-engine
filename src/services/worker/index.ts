import { checkHealth, HEALTHCHECK_FLAG } from "./utils/health.ts";

if (process.argv.includes(HEALTHCHECK_FLAG)) {
  process.exit(checkHealth());
}

await import("./worker.ts");
