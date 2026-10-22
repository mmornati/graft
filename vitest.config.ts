import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["test/setup.ts"],
          // Heavy matcher and eval tests: generous so that a loaded machine never fails them on time.
          testTimeout: 120000,
          hookTimeout: 60000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["test/setup.ts", "test/setup-integration.ts"],
          globalSetup: ["test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
