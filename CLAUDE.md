# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CAPS (Climate Automation & Prediction Scheduler) is a TypeScript/Bun automation system that orchestrates a three-stage
pipeline for DHIS2-based health programs:

1. **Climate Data Acquisition** — Fetch data from ERA5/CHIRPS via openEO
2. **Prediction Generation** — Pass climate + DHIS2 data to the CHAP system for epidemiological forecasting
3. **DHIS2 Data Import** — Import predictions (thresholds, alerts, events, analytics runs) back into DHIS2

There are three services, all entry points under `src/services/`:

- **`worker/`** — RabbitMQ consumer that executes pipelines (`worker.ts`)
- **`scheduler/`** — single-replica cron trigger service (`index.ts`)
- **`api/`** — REST API for monitoring/operating pipelines, built with Burger API (`index.ts`)

## Runtime & Tooling

This project uses **Bun** exclusively — not Node.js, npm, pnpm, or Vite.

| Task            | Command                                                  |
| --------------- | -------------------------------------------------------- |
| Dev (worker)    | `bun run dev:worker`                                     |
| Dev (scheduler) | `bun run dev:scheduler`                                  |
| Dev (API)       | `bun run dev:api`                                        |
| Test            | `bun run test`                                           |
| Test (watch)    | `bun run test:watch`                                     |
| Test (coverage) | `bun run test:coverage`                                  |
| Single test     | `bunx --bun vitest run src/tests/unit/foo.test.ts`       |
| Typecheck       | `bun run typecheck`                                      |
| Lint            | `bun run lint`                                           |
| Lint fix        | `bun run lint:fix`                                       |
| Format          | `bun run format`                                         |
| Build (one svc) | `bun run build:api` / `build:worker` / `build:scheduler` |
| Build (all)     | `bun run build`                                          |

`bun run build` compiles all three services to standalone binaries via `scripts/compile.ts <service>`, then packages them via `scripts/package-app.ts`. Production images (`api`, `worker`, `scheduler`) run these binaries on distroless (`gcr.io/distroless/cc-debian12`); a fourth `migrate` image (`oven/bun:1-slim`) runs `prisma migrate deploy` as a one-shot job. Distroless images have no shell — inspect with `docker logs`, not `docker exec`.

### Running the full stack (Docker)

The `Makefile` wraps `docker-compose.yml`:

| Command          | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `make up`        | Build images and start all services detached                                      |
| `make up-chap`   | Start using CHAP's existing postgres/RabbitMQ (`docker-compose.chap.yml` overlay) |
| `make down`      | Stop all services (volumes preserved)                                             |
| `make down-chap` | Stop the CHAP-overlay stack                                                       |
| `make logs`      | Follow logs for all services                                                      |
| `make migrate`   | Run database migrations manually                                                  |
| `make worker`    | Start worker-1 and worker-2 only                                                  |
| `make scheduler` | Start scheduler only                                                              |
| `make api`       | Start API server only                                                             |
| `make db-shell`  | Open a psql shell in the postgres container                                       |
| `make rabbit`    | Open RabbitMQ management UI                                                       |
| `make test`      | Run the vitest test suite                                                         |
| `make reset`     | Stop all services and delete all volumes                                          |

Hot reload is not available inside Docker. For local iteration, run `bun run dev:api` / `dev:worker` / `dev:scheduler` on the host against the Postgres/RabbitMQ ports published by `make up`.

Two workers run by default (`worker-1`, `worker-2`) — they are stateless and safe to scale horizontally. Exactly one scheduler instance must run at all times; running multiple will cause duplicate pipeline triggers.

## Database (Prisma)

| Command               | Purpose                                |
| --------------------- | -------------------------------------- |
| `bun run db:generate` | Regenerate Prisma client from schemas  |
| `bun run db:migrate`  | Apply pending migrations (dev)         |
| `bun run db:studio`   | Open Prisma Studio UI                  |
| `bun run db:seed`     | Seed example pipelines/data            |
| `bun run db:reset`    | Reset database (dev only, destructive) |

Prisma schemas are split by concern under `prisma/schemas/`: `pipeline.prisma`, `run.prisma`, `log.prisma`, `schedule.prisma`, `enums.prisma`, `schema.prisma`. Generated client is at `prisma/generated/prisma/`.

Tests require a running Postgres and read `DATABASE_URL_TEST` from `.env`; the `caps_test` database must exist beforehand (`make db-shell` → `CREATE DATABASE caps_test;`).

## Bun API Preferences

- `Bun.serve()` for HTTP/WebSocket servers — not `express`
- `bun:sqlite` for SQLite — not `better-sqlite3`
- `Bun.sql` for PostgreSQL — not `pg` or `postgres.js`
- `Bun.redis` for Redis — not `ioredis`
- `Bun.file` for file I/O — not `node:fs` readFile/writeFile
- `Bun.$\`cmd\``for shell commands — not`execa`
- `WebSocket` is built-in — not `ws`
- `.env` is loaded automatically — no `dotenv` needed

## TypeScript Path Aliases

Configured in `tsconfig.json`:

| Alias          | Resolves to                   |
| -------------- | ----------------------------- |
| `@/*`          | `./src/*`                     |
| `@db/*`        | `./prisma/generated/prisma/*` |
| `~types/*`     | `./types/*`                   |
| `@ecosystem/*` | `./ecosystem/*`               |

Note: `vitest.config.ts` additionally aliases `@types/*` → `./types/*` for the test environment (distinct from the `~types/*` alias used in app code).

## Architecture

### Message-Driven Pipeline

The worker service uses RabbitMQ to coordinate pipeline execution, with a transactional outbox for reliable publishing:

1. A `PipelineExecution` is created (via API or scheduler) and written to the `OutboxMessage` table in the same transaction as the triggering write
2. `OutboxPublisher` (`src/services/worker/services/outbox/publisher.ts`) polls PENDING/expired-LEASED outbox rows and publishes them to `pipeline.executions` with RabbitMQ confirms — a crash may redeliver, so consumers must be idempotent on attempt IDs
3. `PipelineCoordinator` (`src/services/worker/services/runners/pipeline.ts`) consumes the execution, advances through steps one at a time
4. For **inline steps**: `StepRunner` (`services/runners/step.ts`) executes directly in the coordinator process
5. For **queued steps**: coordinator publishes to a step-specific queue (`step.climate-openeo-create`, etc.), sets status to `AWAITING_STEP`, and suspends
6. `StepWorker` (`services/workers/step.ts`) picks up the job, executes the handler, and publishes the result to `pipeline.step-results`
7. Coordinator wakes up, advances the cursor, and repeats until complete

Dead-lettered messages go to `caps.dlx` exchange → `caps.dead-letters` queue. `DlxMonitor` (`services/monitor/monitor.ts`) watches this and marks the corresponding execution as `FAILED`. `services/monitor/topology.ts` is the single source of truth for RabbitMQ queue/exchange declarations.

### Scheduler

`src/services/scheduler/` loads active cron-only `PipelineSchedule` rows into an in-memory [Croner](https://github.com/hexagon/croner) job map (one job per schedule id), firing with each schedule's `inputContext` attached via Croner's `context` option. Postgres `LISTEN/NOTIFY` on `caps_schedule_events` (`schedule-events.ts`) keeps the map in sync when schedules are created/paused/updated/deleted or a pipeline is deactivated. Missed ticks during downtime are **not** replayed. Triggered executions go through the same durable outbox described above and still respect each pipeline's `concurrencyPolicy`. Cron expressions are 5-part, evaluated in the host server's IANA timezone.

### Handler System

Step logic is implemented as plugins. Handlers are registered by key in the `HANDLERS` map (`Handlers` enum → `HandlerRegistryEntry`) at `src/services/worker/constants/handlers.ts`, and re-exported from `src/services/worker/services/handlers/index.ts`. Each handler directory under `services/handlers/` implements:

```typescript
interface StepHandler {
  execute(ctx: StepContext): Promise<unknown>;
}
```

`StepContext` (`src/services/worker/types/service.ts`) provides the step definition, shared pipeline context (JSON passed between steps), sub-task reporting (`ctx.tasks`), and a `ctx.log()` method that writes to `ExecutionLog`. `src/shared/handlers/catalog.ts` converts each handler's Zod config/context schemas to JSON Schema for the API's handler-catalog endpoint.

Current handlers (see `Handlers` enum): climate acquisition via openEO (`climate-openeo-{create,poll,download}`), CHAP predictions (`prediction-{trigger,poll,data-download}`), and DHIS2 import (`dhis2-data-upload`, `dhis2-analytics-run`, `threshold-generation`, `alert-generation`, `event-data-upload`).

### Key Files

| File                                               | Purpose                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `src/services/worker/worker.ts`                    | Worker entry point: initializes RabbitMQ topology, wires up consumers |
| `src/services/scheduler/index.ts`                  | Scheduler entry point                                                 |
| `src/services/api/index.ts`                        | API entry point (Burger API)                                          |
| `src/services/worker/services/runners/pipeline.ts` | `PipelineCoordinator` — main orchestrator                             |
| `src/services/worker/services/runners/step.ts`     | `StepRunner` — inline step execution                                  |
| `src/services/worker/services/workers/step.ts`     | `StepWorker` — queued step execution                                  |
| `src/services/worker/services/outbox/publisher.ts` | `OutboxPublisher` — transactional outbox delivery                     |
| `src/services/worker/constants/handlers.ts`        | `Handlers` enum and `HANDLERS` registry                               |
| `src/services/worker/types/service.ts`             | `StepHandler`/`StepContext` types                                     |
| `src/services/worker/services/monitor/topology.ts` | RabbitMQ queue/exchange declarations (single source of truth)         |
| `src/services/worker/services/monitor/monitor.ts`  | Dead-letter queue monitor                                             |
| `src/services/scheduler/scheduler.ts`              | Croner job map management                                             |
| `src/services/scheduler/schedule-events.ts`        | Postgres LISTEN/NOTIFY sync for schedule changes                      |
| `src/shared/pipeline/outbox.ts`                    | Outbox write helpers (used inside triggering transactions)            |
| `src/shared/handlers/catalog.ts`                   | Zod → JSON Schema handler catalog for the API                         |
| `src/shared/clients/db.ts`                         | Prisma client factory                                                 |

### Database Schema Overview

**Definition models** (blueprints): `Pipeline`, `PipelineStep`, `PipelineSchedule` — immutable config.

**Execution models** (runtime state): `PipelineExecution` (status machine: PENDING → RUNNING → AWAITING_STEP → COMPLETED/FAILED), `StepExecution`, `TaskExecution`, `StepRetryCommand` — mutable, cursor-driven.

**Delivery**: `OutboxMessage` — transactional outbox rows for reliable RabbitMQ publishing.

**Observability**: `ExecutionLog` — append-only log records attached to execution/step/task.

## Testing

This project uses **Vitest** (not `bun test`). Tests live under `src/tests/`, split into two projects configured in `vitest.config.ts`:

| Suite       | Location                                    | Timeout                                      |
| ----------- | ------------------------------------------- | -------------------------------------------- |
| Unit        | `src/tests/unit/**/*.{test,spec}.ts`        | default                                      |
| Integration | `src/tests/integration/**/*.{test,spec}.ts` | 60s test / 120s hook (container image pulls) |

Coverage outputs to `coverage/` and enforces minimum thresholds on functions/branches (currently a floor at existing coverage, 49%/45%; target 80%). Source files must live under `src/` to be included in coverage. `test:coverage` runs Vitest under Node (Bun's runtime doesn't support coverage).

Integration tests need a real Postgres and RabbitMQ (`DATABASE_URL_TEST`, `RABBITMQ_URL_TEST`) and run one file at a time because they share one database. CI provides both as service containers.

## Environment Variables

Key variables (see `.env.example`):

| Variable            | Purpose                                                        | Default            |
| ------------------- | -------------------------------------------------------------- | ------------------ |
| `DATABASE_URL`      | PostgreSQL connection string                                   | —                  |
| `DATABASE_URL_TEST` | Postgres connection string for vitest                          | —                  |
| `RABBITMQ_URL`      | RabbitMQ URI                                                   | `amqp://localhost` |
| `API_PORT`          | Port exposed on the host for the API                           | `4000`             |
| `NODE_ENV`          | Runtime environment (`production`, `development`, `test`)      | `production`       |
| `CHAP_NETWORK`      | Docker network CHAP is on (only for `docker-compose.chap.yml`) | —                  |
| `CHAP_DATABASE_URL` | Postgres URL pointing at CHAP's shared postgres instance       | —                  |
| `CHAP_RABBITMQ_URL` | RabbitMQ URL pointing at CHAP's shared RabbitMQ instance       | —                  |

Use `docker-compose.yml` (via `make up`) to run PostgreSQL and RabbitMQ locally, or `make up-chap` to connect to CHAP's existing instances.

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
