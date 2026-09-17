.PHONY: up up-chap down down-chap logs migrate worker scheduler api db-shell rabbit test reset

# Load .env so Make targets can reference variables like POSTGRES_USER
ifneq (,$(wildcard ./.env))
  include .env
  export
endif

# ============================================================
# Compose lifecycle
# ============================================================

## Start all services in detached mode
up:
	docker compose up -d --build

## Start all services using CHAP's postgres and RabbitMQ
up-chap:
	docker compose -f docker-compose.yml -f docker-compose.chap.yml up -d --build

## Stop all services (preserves volumes)
down:
	docker compose down

## Stop all CHAP-overlay services
down-chap:
	docker compose -f docker-compose.yml -f docker-compose.chap.yml down

## Follow logs for all services
logs:
	docker compose logs -f

# ============================================================
# Individual service shortcuts
# ============================================================

## Run the migration container once (applies pending migrations)
migrate:
	docker compose run --rm migrate

## Start both worker instances
worker:
	docker compose up --build worker-1 worker-2

## Start the scheduler (one instance only)
scheduler:
	docker compose up --build scheduler

## Start the API server
api:
	docker compose up --build api

# ============================================================
# Tooling
# ============================================================

## Open a psql shell inside the postgres container
db-shell:
	docker compose exec postgres psql -U $(POSTGRES_USER) $(POSTGRES_DB)

## Open the RabbitMQ management UI in the default browser
rabbit:
	open http://localhost:15672

# ============================================================
# Testing
# ============================================================

## Run the full vitest suite against the test database
## DATABASE_URL_TEST must point at a running Postgres instance
test:
	DATABASE_URL=$(DATABASE_URL_TEST) bunx --bun vitest run

# ============================================================
# Destructive operations
# ============================================================

## Full reset — stops all services and deletes all volumes
## WARNING: destroys all data including the postgres database
reset:
	docker compose down -v
