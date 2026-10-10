import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { nameFromEmail } from "@/lib/team";
import { getMemberships, requireWorkspace, type WorkspaceRole } from "@/lib/workspace";

// The signed-in member's own account: who they are and where they belong. PUT changes
// their name. Their password is changed through /api/auth/change-password.

export interface AccountPayload {
  id: string;
  email: string;
  /** The name they chose. Empty until they set one. */
  name: string;
  /** What is shown for them when they have not set a name. */
  shown_as: string;
  email_verified: boolean;
  created_at: string | null;
  workspaces: Array<{ id: string; name: string; role: WorkspaceRole; suspended: boolean; current: boolean }>;
}

export const MAX_NAME = 80;

function read(userId: string, workspaceId: string): AccountPayload | null {
  const user = getDb().prepare("SELECT id, email, name, email_verified_at, created_at FROM users WHERE id = ?").get(userId) as
    | { id: string; email: string; name: string | null; email_verified_at: string | null; created_at: string | null }
    | undefined;
  if (!user) return null;
  const memberships = getMemberships(userId) as Array<{ id: string; name: string; role: WorkspaceRole; suspended: number }>;
  return {
    id: user.id, email: user.email, name: user.name?.trim() ?? "", shown_as: user.name?.trim() || nameFromEmail(user.email),
    email_verified: Boolean(user.email_verified_at), created_at: user.created_at,
    workspaces: memberships.map((membership) => ({ id: membership.id, name: membership.name, role: membership.role, suspended: Boolean(membership.suspended), current: membership.id === workspaceId })),
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "An account belongs to a signed-in member" });

  if (req.method === "GET") {
    const account = read(ctx.userId, ctx.workspaceId);
    return account ? res.json(account) : res.status(401).json({ error: "Not authenticated" });
  }

  if (req.method === "PUT") {
    const raw = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof raw !== "string") return res.status(400).json({ error: "name is required" });
    const name = raw.trim().replace(/\s+/g, " ");
    if (name.length > MAX_NAME) return res.status(400).json({ error: `A name can be at most ${MAX_NAME} characters` });
    // An empty name is allowed: the member is then shown by their email address.
    getDb().prepare("UPDATE users SET name = ? WHERE id = ?").run(name || null, ctx.userId);
    return res.json(read(ctx.userId, ctx.workspaceId));
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
