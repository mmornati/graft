import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["test/setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["test/setup.ts"],
          globalSetup: ["test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
