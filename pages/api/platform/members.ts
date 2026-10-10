import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { changeMember, listMembers, type TeamMember } from "@/lib/team";
import { getMemberships, recordAudit, requireWorkspace, type WorkspaceRole } from "@/lib/workspace";
import { listWorkspaceInvitations, type InvitationView } from "@/lib/workspace-invitations";

// The Team & roles screen's people: every member with their role, state, last activity
// and campaigns, the invitations still waiting, and the workspaces the reader belongs to.
// PATCH changes one member's role, or suspends or restores them.

export interface TeamOverview {
  workspace: { id: string; name: string; created_at: string | null };
  /** The member reading this. Null for a call made on no member's behalf. */
  you: string | null;
  your_role: WorkspaceRole;
  members: TeamMember[];
  /** Invitations not yet accepted: waiting, or expired. Revoked ones are left out. */
  invitations: Array<Pick<InvitationView, "id" | "email" | "role" | "status" | "created_at" | "last_sent_at" | "expires_at" | "invited_by_email">>;
  /** Every workspace the reader belongs to, with how many members each has. */
  workspaces: Array<{ id: string; name: string; role: WorkspaceRole; suspended: boolean; members: number }>;
  /** API keys that are still usable, by the member who created them. A suspended member's keys keep working. */
  active_api_keys: Record<string, number>;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") {
    const workspace = db.prepare("SELECT id, name, created_at FROM workspaces WHERE id = ?").get(ctx.workspaceId) as TeamOverview["workspace"];
    const memberships = ctx.userId ? (getMemberships(ctx.userId) as Array<{ id: string; name: string; role: WorkspaceRole; suspended: number }>) : [];
    const count = db.prepare("SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ?");
    const keys = db.prepare(
      "SELECT created_by, COUNT(*) AS c FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now')) AND created_by IS NOT NULL GROUP BY created_by",
    ).all(ctx.workspaceId) as Array<{ created_by: string; c: number }>;
    const payload: TeamOverview = {
      workspace,
      you: ctx.userId,
      your_role: ctx.role,
      members: listMembers(db, ctx.workspaceId),
      invitations: listWorkspaceInvitations(ctx.workspaceId)
        .filter((invitation) => invitation.status === "pending" || invitation.status === "expired")
        .map(({ id, email, role, status, created_at, last_sent_at, expires_at, invited_by_email }) => ({ id, email, role, status, created_at, last_sent_at, expires_at, invited_by_email })),
      workspaces: memberships.map((membership) => ({
        id: membership.id, name: membership.name, role: membership.role, suspended: Boolean(membership.suspended),
        members: (count.get(membership.id) as { c: number }).c,
      })),
      // Only whoever can act on it needs to know.
      active_api_keys: ctx.role === "owner" || ctx.role === "admin" ? Object.fromEntries(keys.map((row) => [row.created_by, row.c])) : {},
    };
    return res.json(payload);
  }

  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as { user_id?: unknown; role?: unknown; suspended?: unknown };
    if (typeof body.user_id !== "string" || !body.user_id) return res.status(400).json({ error: "user_id is required" });
    const result = changeMember(db, ctx.workspaceId, ctx, body.user_id, {
      ...(body.role !== undefined ? { role: body.role as WorkspaceRole } : {}),
      ...(body.suspended !== undefined ? { suspended: body.suspended as boolean } : {}),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.now.role !== result.previous.role) recordAudit(ctx, "workspace.member_role_changed", "user", body.user_id, { role: result.now.role, previous: result.previous.role });
    if (result.now.suspended !== result.previous.suspended) recordAudit(ctx, result.now.suspended ? "workspace.member_suspended" : "workspace.member_restored", "user", body.user_id);
    return res.json({ ok: true, member: listMembers(db, ctx.workspaceId).find((member) => member.id === body.user_id) ?? null });
  }

  res.setHeader("Allow", ["GET", "PATCH"]);
  return res.status(405).end();
}
