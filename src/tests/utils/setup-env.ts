// Setup file — runs inside each test worker process.
// When the integration global-setup has started containers it publishes
// the real URLs via vitest `provide`; we inject them here so that every
// helper (createTestPrisma, createTestChannel, …) just reads process.env.
//
// For unit tests (no globalSetup) the `inject` calls return undefined and
// the fallbacks below are used instead.

import { inject } from "vitest";

const injectedDbUrl = inject("databaseUrlTest");
const injectedRmqUrl = inject("rabbitmqUrlTest");
const injectedChapUrl = inject("chapBaseUrl");

// DATABASE_URL_TEST — real Postgres container in integration suite
if (injectedDbUrl) {
  process.env["DATABASE_URL_TEST"] = injectedDbUrl;
} else if (!process.env["DATABASE_URL_TEST"]) {
  process.env["DATABASE_URL_TEST"] = "postgresql://caps:caps@localhost:5432/caps_test";
}

// DATABASE_URL — fallback used by Prisma CLI and legacy code paths
if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = process.env["DATABASE_URL_TEST"]!;
}

// RABBITMQ_URL_TEST — real RabbitMQ container in integration suite
if (injectedRmqUrl) {
  process.env["RABBITMQ_URL_TEST"] = injectedRmqUrl;
} else if (!process.env["RABBITMQ_URL_TEST"]) {
  process.env["RABBITMQ_URL_TEST"] = "amqp://guest:guest@localhost:5672";
}

// CHAP_BASE_URL — real CHAP container in integration suite
if (injectedChapUrl) {
  process.env["CHAP_BASE_URL"] = injectedChapUrl;
} else if (!process.env["CHAP_BASE_URL"]) {
  process.env["CHAP_BASE_URL"] = "http://localhost:8000";
}

// Remaining vars required by the app env schema
if (!process.env["DHIS2_PAT"]) {
  process.env["DHIS2_PAT"] = "test-dhis2-pat";
}
if (!process.env["DHIS2_BASE_URL"]) {
  process.env["DHIS2_BASE_URL"] = "http://localhost:8080";
}
