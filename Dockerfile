# syntax=docker/dockerfile:1
#
# Multi-target production images:
#   api        — compiled Bun executable on distroless
#   worker     — compiled Bun executable on distroless
#   scheduler  — compiled Bun executable on distroless
#   migrate    — Bun + Prisma CLI (not compiled)
#
# Cross-compile api/worker/scheduler from BUILDPLATFORM using TARGETARCH.
# migrate installs on the target platform so Prisma engines match.

# ---------------------------------------------------------------------------
# Shared compile builder
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:1 AS deps
WORKDIR /app
ENV HUSKY=0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS source
COPY . .
RUN bun prisma generate

FROM source AS compile-api
ARG TARGETARCH
ENV TARGETARCH=${TARGETARCH}
RUN bun run scripts/compile.ts api

FROM source AS compile-worker
ARG TARGETARCH
ENV TARGETARCH=${TARGETARCH}
RUN bun run scripts/compile.ts worker

FROM source AS compile-scheduler
ARG TARGETARCH
ENV TARGETARCH=${TARGETARCH}
RUN bun run scripts/compile.ts scheduler

# ---------------------------------------------------------------------------
# Runtime: compiled binaries
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=compile-api --chown=nonroot:nonroot /app/.build/caps-api /app/caps-api
USER nonroot
ENTRYPOINT ["/app/caps-api"]

FROM gcr.io/distroless/cc-debian12:nonroot AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=compile-worker --chown=nonroot:nonroot /app/.build/caps-worker /app/caps-worker
USER nonroot
ENTRYPOINT ["/app/caps-worker"]

FROM gcr.io/distroless/cc-debian12:nonroot AS scheduler
WORKDIR /app
ENV NODE_ENV=production
COPY --from=compile-scheduler --chown=nonroot:nonroot /app/.build/caps-scheduler /app/caps-scheduler
USER nonroot
ENTRYPOINT ["/app/caps-scheduler"]

# ---------------------------------------------------------------------------
# Runtime: migrations (Prisma CLI needs Bun + schema/SQL files)
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim AS migrate
WORKDIR /app
ENV NODE_ENV=production
ENV HUSKY=0
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
CMD ["bunx", "prisma", "migrate", "deploy"]
