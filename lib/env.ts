// Fail-fast environment validation, run once at server startup (instrumentation.ts)
// BEFORE the background runner is imported. The goal is a single, clear error at
// boot instead of confusing downstream failures (e.g. NEXTAUTH_SECRET is the HKDF
// input for lib/crypto.ts, so a missing value silently breaks session decryption).
//
// This module contains no LinkedIn/browser logic and never imports the runner.

type EnvIssue = { name: string; reason: string };

/**
 * Validate process environment. In production, missing REQUIRED variables throw a
 * single aggregated error. Missing RECOMMENDED variables only warn. Outside
 * production (dev/test) nothing throws, so local workflows and unit tests are
 * unaffected.
 *
 * Returns the list of warnings emitted (useful for tests); throws on required
 * failures in production.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const isProduction = env.NODE_ENV === "production";

  const missing: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];

  const isBlank = (v: string | undefined) => !v || v.trim() === "";

  // Required in production. NEXTAUTH_SECRET signs sessions AND derives the
  // encryption key for stored email passwords, LinkedIn cookies, API keys, and
  // webhook secrets - without it those cannot be decrypted.
  if (isBlank(env.NEXTAUTH_SECRET)) {
    missing.push({
      name: "NEXTAUTH_SECRET",
      reason: "required to sign sessions and derive the secret-encryption key. Generate with: openssl rand -base64 32",
    });
  }

  // Recommended: needed for correct NextAuth redirects and as the default base
  // for email open/click tracking URLs. Not fatal, but misconfiguration causes
  // broken login redirects and tracking links in production.
  if (isBlank(env.NEXTAUTH_URL)) {
    warnings.push({
      name: "NEXTAUTH_URL",
      reason: "not set - NextAuth redirects and default email tracking URLs may be incorrect.",
    });
  }

  // Recommended: server-to-server secret for the MCP server calling Linki's own
  // API over loopback. Only needed if the MCP endpoint is used, so warn only.
  if (isBlank(env.INTERNAL_API_SECRET)) {
    warnings.push({
      name: "INTERNAL_API_SECRET",
      reason: "not set - internal service calls (e.g. the MCP server) will be unauthenticated or fail.",
    });
  }

  for (const w of warnings) {
    console.warn(`[env] Warning: ${w.name} ${w.reason}`);
  }

  if (missing.length > 0) {
    const details = missing.map(m => `  - ${m.name}: ${m.reason}`).join("\n");
    const message =
      `Invalid environment configuration. The following required variable(s) are missing:\n${details}\n` +
      `See .env.example for the full list.`;
    if (isProduction) {
      throw new Error(message);
    }
    // In dev/test, surface the problem loudly but do not crash the process.
    console.warn(`[env] ${message}`);
  }

  return warnings;
}
