import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup/pdfjs.ts"],
    testTimeout: 15_000,
    coverage: {
      enabled: false,
    },
  },
});
