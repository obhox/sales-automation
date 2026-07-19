export async function register() {
  // Only run on the Node.js server runtime, not in the browser/edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast on misconfiguration before booting the background runner. On a
    // valid environment this is a no-op and the runner starts identically.
    const { validateEnv } = await import("@/lib/env");
    validateEnv();

    try {
      const { ensureGlobalRunnerStarted } = await import("@/lib/linkedin/runner");
      ensureGlobalRunnerStarted();
    } catch (err) {
      console.error("[instrumentation] Failed to start runner:", err);
    }
  }
}
