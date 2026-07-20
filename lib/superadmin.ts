// Instance-level ("superadmin") access control.
//
// This is deliberately NOT part of the workspace role system. workspace_members.role
// is per-workspace, and granting instance-wide power through it would make the
// member-management API an escalation path. Instead an operator lists admin emails in
// the SUPERADMIN_EMAILS env var, so the privilege can only be granted with deploy /
// server access and can never be self-granted through the app.
//
// SECURITY: the check re-derives identity from the SIGNED SESSION via getServerSession.
// It must never trust the x-workspace-id / x-user-id / x-workspace-role request headers:
// proxy.ts injects those, and lib/workspace.ts defaults a missing or malformed role
// header to "owner", so a header-based check would be trivially forgeable.
import type { NextApiRequest, NextApiResponse } from "next";
import type { GetServerSidePropsContext } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

type AnyRequest = NextApiRequest | GetServerSidePropsContext["req"];
type AnyResponse = NextApiResponse | GetServerSidePropsContext["res"];

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

/** Resolve the signed-in email from the session cookie. Never reads request headers. */
export async function sessionEmail(req: AnyRequest, res: AnyResponse): Promise<string | null> {
  const session = await getServerSession(req as NextApiRequest, res as NextApiResponse, authOptions);
  return session?.user?.email ?? null;
}

/**
 * API-route guard. Returns the admin's email, or null after having already responded.
 *
 * Responds 404 rather than 403 on purpose: a normal signed-in user should not be able
 * to discover that an instance-admin surface exists at all.
 */
export async function requireSuperadmin(req: NextApiRequest, res: NextApiResponse): Promise<string | null> {
  const email = await sessionEmail(req, res);
  if (!isSuperadminEmail(email)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return email!.trim().toLowerCase();
}

/** SSR guard for the admin page. Returns the email or null (caller should 404). */
export async function getSuperadmin(ctx: GetServerSidePropsContext): Promise<string | null> {
  const email = await sessionEmail(ctx.req, ctx.res);
  return isSuperadminEmail(email) ? email!.trim().toLowerCase() : null;
}
