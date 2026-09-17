# CAPS — Climate Automation & Prediction Scheduler

CAPS is an automation and scheduling system that connects climate data sources, predictive modeling, and DHIS2 data import into a single configurable pipeline. It orchestrates three stages: climate data acquisition (ERA5/CHIRPS via openEO-style climate APIs), prediction generation via [CHAP](https://github.com/dhis2-chap/chap-core), and import of results back into DHIS2.

Repository: [hisptz/caps-engine](https://github.com/hisptz/caps-engine). Operator UI: [hisptz/caps-app](https://github.com/hisptz/caps-app) (DHIS2 web app).

**License:** [BSD 3-Clause](./LICENSE). Copyright © 2026 HISP Tanzania. `package.json` `"license": "BSD-3-Clause"`.

### Features

- Configurable **pipelines** and **steps** stored in Postgres (Prisma)
- **Scheduler** (Croner, single replica) and manual API triggers
- **Workers** that run handler plugins (climate openEO, CHAP predictions, DHIS2 import, thresholds, alerts)
- REST **API** (Elysia) for operators; RabbitMQ + transactional outbox for delivery
- Docker images on GHCR: `ghcr.io/hisptz/caps-engine/{api,worker,scheduler,migrate}`

### Tech stack

Bun, TypeScript, Elysia, Prisma 7, PostgreSQL 16, RabbitMQ, Croner, Zod, Vitest, Docker (distroless compiled binaries).

---

## Prerequisites

- [Bun](https://bun.sh) 1.x (for running tests and local development outside Docker)
- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/) v2 (ships with Docker Desktop)

---

## First-time setup

```bash
cp .env.example .env
# Edit .env and set secure passwords for POSTGRES_PASSWORD and RABBITMQ_PASSWORD
make up
```

Docker Compose will start postgres and rabbitmq, run database migrations, and then start all three application services. On the first run, four images are compiled from source — this takes a few minutes.

Hot reload is not available inside Docker (api, worker, and scheduler are compiled binaries on distroless). Use `bun run dev:api`, `bun run dev:worker`, and `bun run dev:scheduler` on the host against the published Postgres/RabbitMQ ports.

---

## Running locally (standalone)

```bash
make up        # build images and start everything in detached mode
make logs      # follow logs for all services
make down      # stop everything (volumes preserved)
make reset     # stop everything and delete all volumes (full reset)
```

Available ports after `make up`:

| Service             | URL                    |
| ------------------- | ---------------------- |
| API                 | http://localhost:4000  |
| RabbitMQ management | http://localhost:15672 |
| Postgres            | localhost:5432         |

---

## Running alongside CHAP

If CHAP is already running in Docker, you can connect CAPS to CHAP's existing postgres and RabbitMQ instead of spinning up duplicates.

**Required .env variables:**

```
CHAP_NETWORK=chap_default        # Docker network CHAP is on
CHAP_DATABASE_URL=postgresql://caps:changeme@chap-postgres:5432/caps
CHAP_RABBITMQ_URL=amqp://caps:changeme@chap-rabbitmq:5672
```

**How to find the CHAP network name:**

```bash
docker network ls | grep chap
```

**How to find CHAP's postgres container hostname:**

```bash
docker inspect <chap_postgres_container_name>
# Look for "Name" under Networks — that is the hostname on the shared network
```

**Start CAPS connected to CHAP:**

```bash
make up-chap
make down-chap
```

This uses `docker-compose.chap.yml` as an overlay, which disables the CAPS-managed postgres and rabbitmq services and routes CAPS to the shared CHAP instances.

---

## Running tests

Tests require a running Postgres instance. The test suite reads `DATABASE_URL_TEST` from your environment (or `.env` file).

```bash
# Ensure DATABASE_URL_TEST is set in .env, then:
make test
```

The test database (`caps_test`) must exist before running tests. You can create it manually:

```bash
make db-shell
# Inside psql:
CREATE DATABASE caps_test;
```

---

## Useful commands

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `make up`        | Start all services                          |
| `make up-chap`   | Start using CHAP's postgres and RabbitMQ    |
| `make down`      | Stop all services                           |
| `make logs`      | Follow logs                                 |
| `make migrate`   | Run database migrations manually            |
| `make worker`    | Start worker-1 and worker-2 only            |
| `make scheduler` | Start scheduler only                        |
| `make api`       | Start API server only                       |
| `make db-shell`  | Open a psql shell in the postgres container |
| `make rabbit`    | Open RabbitMQ management UI                 |
| `make test`      | Run the vitest test suite                   |
| `make reset`     | Stop all services and delete all volumes    |

---

## Docker images

Production images are published to GHCR. api, worker, and scheduler are compiled Bun executables on distroless; migrate keeps the Prisma CLI.

| Image                                  | Role                               | Runtime                                      |
| -------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `ghcr.io/hisptz/caps-engine/api`       | REST API                           | distroless (`gcr.io/distroless/cc-debian12`) |
| `ghcr.io/hisptz/caps-engine/worker`    | Pipeline workers                   | distroless                                   |
| `ghcr.io/hisptz/caps-engine/scheduler` | Cron scheduler (single replica)    | distroless                                   |
| `ghcr.io/hisptz/caps-engine/migrate`   | `prisma migrate deploy` (one-shot) | `oven/bun:1-slim`                            |

Images are built for `linux/amd64` and `linux/arm64`. Distroless images have no shell — inspect with `docker logs`, not `docker exec`.

---

## Service overview

**Worker (`src/services/worker/worker.ts`)**
Connects to RabbitMQ and processes pipeline execution messages. Each `PipelineCoordinator` consumes from `pipeline.executions`, advances through pipeline steps one at a time, and dispatches step work to dedicated step queues. Two worker instances run by default (`worker-1`, `worker-2`) for parallel pipeline throughput. You can run more workers — they are stateless and safe to scale horizontally.

**Scheduler (`src/services/scheduler/index.ts`)**
Loads active cron-only `pipeline_schedules` into an in-memory Croner job map (one job per schedule id). Jobs fire with the schedule `inputContext` attached via Croner's `context` option. Postgres `LISTEN/NOTIFY` (`caps_schedule_events`) keeps the map in sync when schedules are created, paused, updated, or deleted, and when a pipeline is deactivated. Missed ticks during downtime are not replayed. Triggered executions go through the durable outbox (the worker publishes to `pipeline.executions`) and still respect each pipeline's `concurrencyPolicy`. Exactly one instance must run at all times — running multiple schedulers will cause duplicate pipeline triggers. Cron expressions are 5-part and evaluated in the host server's IANA timezone.

**API (`src/services/api/index.ts`)**
A REST API built with Elysia that exposes monitoring, operator, and trigger endpoints. It reads execution state from Postgres and publishes trigger messages to RabbitMQ. Stateless — safe to scale horizontally behind a load balancer.

---

## Seeding example data

```bash
# Seed example pipelines (host, against published Postgres on localhost:5432)
bun run db:seed
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md). Security reports: [SECURITY.md](./SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

---

## Environment variables

Names below come from `.env.example`, `docker-compose.yml`, and `src/shared/schemas/env.ts`. Full table: [docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md).

### Standard variables

| Variable                                               | Description                           | Default / notes                                              |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------ |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`  | Compose Postgres image bootstrap      | `.env.example`: `caps` / `caps` / `caps`                     |
| `DATABASE_URL`                                         | Prisma/app Postgres URL               | `.env.example`: `postgresql://caps:caps@localhost/caps`      |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD`                  | Compose RabbitMQ user                 | `.env.example`: `caps` / `caps`                              |
| `RABBITMQ_URL`                                         | AMQP URL                              | `.env.example`: `amqp://caps:caps@localhost:5672`            |
| `PORT`                                                 | API listen port inside the process    | `4000` (`env.ts`)                                            |
| `API_PORT`                                             | Host port mapped to the API container | `4000`                                                       |
| `DHIS2_BASE_URL` / `DHIS2_USERNAME` / `DHIS2_PASSWORD` | DHIS2 connection                      | `.env.example` uses demo `admin` / `district`                |
| `CHAP_BASE_URL`                                        | CHAP HTTP API                         | **Required** in `env.ts`                                     |
| `CHAP_API_TOKEN`                                       | Optional CHAP token                   | Empty in `.env.example`                                      |
| `CLIMATE_API_BASE_URL`                                 | Climate HTTP API                      | `.env.example`: `http://localhost:8001`                      |
| `CLIMATE_DATA_BASE_URL`                                | Climate data service                  | `.env.example`: `http://localhost:8081`                      |
| `OUTPUTS_DIR`                                          | Worker output dir                     | `./outputs`; Compose workers use `/tmp/caps-outputs`         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                          | OTLP exporter                         | Empty in `.env.example`                                      |
| `NODE_ENV`                                             | Runtime label                         | `.env.example`: `production` (not in `env.ts`)               |
| `DATABASE_URL_TEST`                                    | Used by `make test`                   | `.env.example`: `postgresql://caps:caps@localhost/caps_test` |

### CHAP integration variables

Only required when using `docker-compose.chap.yml`.

| Variable            | Description                                       |
| ------------------- | ------------------------------------------------- |
| `CHAP_NETWORK`      | Docker network name CHAP is running on            |
| `CHAP_DATABASE_URL` | Postgres URL pointing at CHAP's postgres instance |
| `CHAP_RABBITMQ_URL` | RabbitMQ URL pointing at CHAP's RabbitMQ instance |
