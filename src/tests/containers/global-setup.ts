import { execSync } from "child_process";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedTestContainer,
  type StartedNetwork,
} from "testcontainers";
import type { Vitest } from "vitest/node";

// ----------------------------------------------------------------
// Type augmentation — keeps `inject()` calls type-safe in tests
// ----------------------------------------------------------------

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrlTest: string;
    rabbitmqUrlTest: string;
    chapBaseUrl: string;
  }
}

interface TestContainers {
  capsPostgres: StartedTestContainer;
  rabbitmq: StartedTestContainer;
  chapPostgres: StartedTestContainer;
  chapRedis: StartedTestContainer;
  chap: StartedTestContainer;
  chapNetwork: StartedNetwork;
}

declare global {
  var __TEST_CONTAINERS__: TestContainers | undefined;
}

const track = (name: string, promise: Promise<StartedTestContainer>) =>
  promise.then((c) => {
    console.log(`[test-containers] ${name} ready.`);
    return c;
  });

// The setup function receives the Vitest instance; provide() is a method on it.
export async function setup(vitest: Vitest): Promise<void> {
  // ----------------------------------------------------------------
  // Start independent services in parallel:
  //   - CAPS PostgreSQL  (CAPS integration tests)
  //   - RabbitMQ         (coordinator / step-worker tests)
  //   - CHAP PostgreSQL  (CHAP stack dependency)
  //   - CHAP Redis       (CHAP stack dependency — valkey/valkey:8)
  // ----------------------------------------------------------------
  console.log("[test-containers] Creating Docker network for CHAP stack...");
  const chapNetwork = await new Network().start();
  console.log(
    "[test-containers] Network ready. Starting CAPS Postgres, RabbitMQ, CHAP Postgres, CHAP Redis in parallel..."
  );

  const [capsPostgres, rabbitmq, chapPostgres, chapRedis] = await Promise.all([
    // CAPS Postgres
    track(
      "CAPS Postgres",
      new GenericContainer("postgres:17-alpine")
        .withEnvironment({
          POSTGRES_USER: "caps",
          POSTGRES_PASSWORD: "caps",
          POSTGRES_DB: "caps_test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
        .start()
    ),

    // RabbitMQ
    track(
      "RabbitMQ",
      new GenericContainer("rabbitmq:3-alpine")
        .withExposedPorts(5672)
        .withWaitStrategy(Wait.forLogMessage("Server startup complete"))
        .start()
    ),

    // CHAP Postgres — inside the shared CHAP network, aliased "postgres"
    track(
      "CHAP Postgres",
      new GenericContainer("postgres:17")
        .withNetwork(chapNetwork)
        .withNetworkAliases("postgres")
        .withEnvironment({
          POSTGRES_USER: "chap",
          POSTGRES_PASSWORD: "chap",
          POSTGRES_DB: "chap_core",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
        .start()
    ),

    // CHAP Redis (Valkey) — inside the shared CHAP network, aliased "redis"
    track(
      "CHAP Redis (Valkey)",
      new GenericContainer("valkey/valkey:8-alpine")
        .withNetwork(chapNetwork)
        .withNetworkAliases("redis")
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forListeningPorts())
        .start()
    ),
  ]);

  // ----------------------------------------------------------------
  // Apply CAPS Prisma migrations against the test database
  // ----------------------------------------------------------------
  const capsDbUrl = `postgresql://caps:caps@${capsPostgres.getHost()}:${capsPostgres.getMappedPort(5432)}/caps_test`;

  console.log("[test-containers] Running Prisma migrations...");
  execSync("bunx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: capsDbUrl },
  });
  console.log("[test-containers] Migrations applied.");

  const rabbitmqUrl = `amqp://guest:guest@${rabbitmq.getHost()}:${rabbitmq.getMappedPort(5672)}`;

  // ----------------------------------------------------------------
  // CHAP API — https://github.com/dhis2-chap/chap-core
  // Mirrors the environment from the upstream compose.yml.
  // The Celery worker is omitted here; add it if handler tests need
  // actual background prediction execution.
  // ----------------------------------------------------------------
  console.log("[test-containers] Starting CHAP API (waiting for /health)...");
  const chap = await new GenericContainer("ghcr.io/dhis2-chap/chap-core:latest")
    .withNetwork(chapNetwork)
    .withEnvironment({
      REDIS_HOST: "redis",
      REDIS_PORT: "6379",
      CHAP_DATABASE_URL: "postgresql://chap:chap@postgres:5432/chap_core",
      CELERY_BROKER: "redis://redis:6379/0",
      // Use ephemeral paths — no volume mounts required for tests
      CHAP_LOGS_DIR: "/tmp/chap/logs",
      CHAP_RUNS_DIR: "/tmp/chap/runs",
    })
    .withExposedPorts(8000)
    // GET /health is the FastAPI health route in chap_core/rest_api/common_routes.py
    .withWaitStrategy(Wait.forHttp("/health", 8000))
    .start();

  const chapBaseUrl = `http://${chap.getHost()}:${chap.getMappedPort(8000)}`;
  console.log(`[test-containers] CHAP API ready at ${chapBaseUrl}`);

  // ----------------------------------------------------------------
  // Publish container URLs to test workers via vitest provide/inject
  // ----------------------------------------------------------------
  vitest.provide("databaseUrlTest", capsDbUrl);
  vitest.provide("rabbitmqUrlTest", rabbitmqUrl);
  vitest.provide("chapBaseUrl", chapBaseUrl);

  console.log("[test-containers] All containers ready.");

  globalThis.__TEST_CONTAINERS__ = {
    capsPostgres,
    rabbitmq,
    chapPostgres,
    chapRedis,
    chap,
    chapNetwork,
  };
}

export async function teardown(): Promise<void> {
  const c = globalThis.__TEST_CONTAINERS__;
  if (!c) return;

  console.log("[test-containers] Stopping containers...");
  // Stop app containers first, then backing services
  await c.chap.stop();
  await Promise.all([
    c.capsPostgres.stop(),
    c.rabbitmq.stop(),
    c.chapRedis.stop(),
    c.chapPostgres.stop(),
  ]);
  await c.chapNetwork.stop();
  console.log("[test-containers] All containers stopped.");
}
