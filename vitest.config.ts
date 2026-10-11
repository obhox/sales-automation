import { defineConfig } from "vitest/config";
import path from "path";

// No test performs a live LinkedIn/email/CRM call, and `npm test` launches no browser.
// Tests that need a database run against a throwaway SQLite file (see tests/setup.ts).
//
// The LinkedIn automation is covered in layers: what its page readers make of LinkedIn's
// markup (linkedin-dom, in jsdom), what the steps and the runner decide (linkedin-steps,
// linkedin-runner, with the browser scripted), and — opt-in, `npm run test:browser` — the
// steps driving a real Chromium against a stand-in LinkedIn served by request interception.
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
