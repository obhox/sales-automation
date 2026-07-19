import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests for non-LinkedIn logic only. No test launches a browser or performs
// a live LinkedIn/email/CRM call. Tests that need a database run against a
// throwaway SQLite file (see tests/setup.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
