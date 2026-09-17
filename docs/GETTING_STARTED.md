# Getting started (CAPS backend)

This is the pipeline engine: **API**, **worker**, and **scheduler**. Operators use the DHIS2 app ([`hisptz/caps-app`](https://github.com/hisptz/caps-app)), which calls this API through a DHIS2 Route (`routes/caps/run`).

## Stack

| Layer           | What is in the repo                                                      |
| --------------- | ------------------------------------------------------------------------ |
| Runtime         | [Bun](https://bun.sh) 1.x (not Node/npm for app code)                    |
| Language        | TypeScript (`"type": "module"`)                                          |
| HTTP API        | Elysia (`src/services/api/index.ts`)                                     |
| Data            | Prisma 7 + PostgreSQL                                                    |
| Queue           | RabbitMQ (`amqplib`), transactional outbox                               |
| Scheduler       | Croner + Postgres `LISTEN/NOTIFY`                                        |
| Tests           | Vitest (`bunx --bun vitest`)                                             |
| Lint / format   | ESLint, Prettier                                                         |
| Containers      | Docker Compose; production images on GHCR (distroless compiled binaries) |
| Package manager | Bun (`bun.lock`)                                                         |

## Prerequisites

- Bun 1.x
- Docker 24+ and Compose v2
- For host-mode services: Postgres and RabbitMQ reachable (Compose publishes `5432` and `5672`)

## Install and run

```bash
git clone https://github.com/hisptz/caps-engine.git
cd caps-engine
cp .env.example .env
```

Edit `.env` if you need non-local hosts. `.env.example` already includes Compose (`POSTGRES_*`, `RABBITMQ_USER`/`PASSWORD`), `API_PORT`, `DATABASE_URL_TEST`, and climate URLs.

```bash
bun install
bun run db:generate
make up
```

`make up` runs `docker compose up -d --build` (postgres, rabbitmq, one-shot `migrate`, `api`, `worker-1`, `worker-2`, `scheduler`).

| Service             | URL                                                        |
| ------------------- | ---------------------------------------------------------- |
| API                 | http://localhost:4000 (`API_PORT` / container `PORT` 4000) |
| RabbitMQ management | http://localhost:15672                                     |
| Postgres            | localhost:5432                                             |

**Compose caveat:** `docker-compose.yml` declares an **external** Docker network named `chap`. If `make up` fails because that network is missing, create it (`docker network create chap`) or join an existing CHAP network. `make up-chap` is the overlay that **disables** CAPS Postgres/RabbitMQ and uses `CHAP_NETWORK`, `CHAP_DATABASE_URL`, and `CHAP_RABBITMQ_URL`.

Hot reload: run on the host, not in distroless containers:

```bash
bun run dev:api
bun run dev:worker
bun run dev:scheduler
```

Seed example pipelines (host, against published Postgres):

```bash
bun run db:seed
```

## Tests, lint, types

```bash
# Create caps_test if needed:
make db-shell
# CREATE DATABASE caps_test;

# Makefile uses DATABASE_URL_TEST → DATABASE_URL for Vitest
make test
# or
bun run test
bun run test:coverage
bun run lint
bun run format:check
bun run typecheck
```

CI (`.github/workflows/ci.yml`) on `main` and PRs to `main`: `bun run lint`, `format:check`, `typecheck`, `test:coverage`.

## Environment variables

### Validated in code (`src/shared/schemas/env.ts`)

| Variable                            | Role                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | Postgres URL for the app (Prisma). Default in schema: `postgres://localhost/caps`.                                |
| `PORT`                              | API listen port. Default `4000`. Compose sets `PORT=4000` in the api container and maps `${API_PORT:-4000}:4000`. |
| `DHIS2_BASE_URL`                    | DHIS2 instance the workers/API talk to.                                                                           |
| `DHIS2_USERNAME` / `DHIS2_PASSWORD` | DHIS2 basic auth (`.env.example` uses demo `admin` / `district`).                                                 |
| `RABBITMQ_URL`                      | AMQP URL. Schema default `amqp://localhost`.                                                                      |
| `CHAP_BASE_URL`                     | CHAP HTTP API. **Required** by the Zod schema (no default).                                                       |
| `CHAP_API_TOKEN`                    | Optional; used when CHAP reports `auth_required`.                                                                 |
| `OUTPUTS_DIR`                       | Worker output directory. Default `./outputs`. Compose sets `/tmp/caps-outputs` on workers.                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`       | OTLP endpoint; empty string disables / default.                                                                   |
| `CLIMATE_API_BASE_URL`              | Climate/openEO-style HTTP API. Schema default `http://localhost:8001`.                                            |
| `CLIMATE_DATA_BASE_URL`             | Climate data service. Schema default `http://localhost:8081`.                                                     |

`.env.example` lists these plus Compose/Makefile names (`POSTGRES_*`, `RABBITMQ_USER`/`PASSWORD`, `API_PORT`, `DATABASE_URL_TEST`, `NODE_ENV`).

### Compose / Makefile (not in `env.ts`)

| Variable                                                   | Role                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`      | Official Postgres image bootstrap (`docker-compose.yml`). |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD`                      | RabbitMQ default user.                                    |
| `API_PORT`                                                 | Host port mapped to the API container.                    |
| `IMAGE_TAG`                                                | Tag for GHCR images (`latest` default).                   |
| `DATABASE_URL_TEST`                                        | Used by `make test` only.                                 |
| `CHAP_NETWORK` / `CHAP_DATABASE_URL` / `CHAP_RABBITMQ_URL` | `docker-compose.chap.yml` overlay.                        |
| `NODE_ENV`                                                 | Present in `.env.example`; not in `env.ts`.               |

`docker-compose.yml` passes `CLIMATE_API_BASE_URL` and `CLIMATE_DATA_BASE_URL` into api, workers, and scheduler. Inside containers, `localhost` in those URLs is the container itself — point them at a reachable climate service hostname on the Compose network.

## Project structure

```
caps/
├── src/
│   ├── services/
│   │   ├── api/              # Elysia REST (index.ts)
│   │   ├── worker/           # RabbitMQ consumers, handlers, outbox (worker.ts)
│   │   └── scheduler/        # Croner + LISTEN/NOTIFY (index.ts)
│   ├── shared/               # Prisma client, env schema, handler catalog, telemetry
│   └── tests/                # unit/ + integration/ (Vitest)
├── prisma/
│   ├── schemas/              # pipeline, run, log, schedule, enums, schema
│   ├── migrations/
│   └── seed.ts
├── docker-compose.yml
├── docker-compose.chap.yml
├── docker-compose.dev.yml    # optional fuller local stack (DHIS2, CHAP, climate-api, …)
├── Dockerfile
├── Makefile
├── CONVENTIONS.md
├── LICENSE
├── package.json
├── bun.lock
└── .env.example
```

Entry points: `src/services/api/index.ts`, `src/services/worker/worker.ts`, `src/services/scheduler/index.ts`.

## Next

- [CONTRIBUTING.md](../CONTRIBUTING.md) — PRs, Conventional Commits
- [CONVENTIONS.md](../CONVENTIONS.md) — handler folders, Zod schemas, queue names
- [README.md](../README.md) — Compose with CHAP, GHCR images, service overview
