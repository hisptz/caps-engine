import { defineConfig } from "vitest/config";
import path from "path";

const aliases = [
  {
    find: /^zod$/,
    replacement: path.resolve(__dirname, "src/tests/utils/zodShim.ts"),
  },
  {
    find: /^@\/(.+)$/,
    replacement: path.resolve(__dirname, "src") + "/$1",
  },
  {
    find: /^@db\/(.+)$/,
    replacement: path.resolve(__dirname, "prisma/generated/prisma") + "/$1",
  },
  {
    find: /^@types\/(.+)$/,
    replacement: path.resolve(__dirname, "types") + "/$1",
  },
];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: "unit",
          include: ["src/tests/unit/**/*.{test,spec}.ts"],
          environment: "node",
          clearMocks: true,
          restoreMocks: true,
          setupFiles: ["src/tests/utils/setup-env.ts"],
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: "integration",
          include: ["src/tests/integration/**/*.{test,spec}.ts"],
          environment: "node",
          clearMocks: true,
          restoreMocks: true,
          // Files share one database and clear it between tests, so they must not run concurrently
          fileParallelism: false,
          // Generous timeouts — container image pulls can be slow on first run
          testTimeout: 60_000,
          hookTimeout: 120_000,
          setupFiles: ["src/tests/utils/setup-env.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "lcov"],
      // Still write reports when tests fail so the CI coverage comment has data
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.{test,spec}.ts"],
      // Floor at current coverage to block regressions; raise as tests are added (target: 80)
      thresholds: {
        functions: 49,
        branches: 45,
      },
    },
  },
});
