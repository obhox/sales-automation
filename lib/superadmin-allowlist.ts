// Pure instance-admin allowlist. Deliberately free of imports so it can be used from
// the NextAuth callbacks without creating a cycle (lib/superadmin.ts imports authOptions
// from the NextAuth route, so that route must not import lib/superadmin.ts back).

/** Parsed, normalised admin allowlist. Empty when unset - meaning nobody is an admin. */
export function superadminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Fail closed: an unset or empty allowlist grants nobody instance access. */
export function isSuperadminEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email) return false;
  const allowlist = superadminEmails(env);
  if (allowlist.length === 0) return false;
  return allowlist.includes(email.trim().toLowerCase());
}
