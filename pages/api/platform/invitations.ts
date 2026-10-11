import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendEmail, type EmailAccount } from "@/lib/email/sender";
import { requireWorkspace, recordAudit, type WorkspaceRole } from "@/lib/workspace";
import { createWorkspaceInvitation, listWorkspaceInvitations, reissueWorkspaceInvitation, revokeWorkspaceInvitation } from "@/lib/workspace-invitations";

const ROLES = new Set<WorkspaceRole>(["owner", "admin", "manager", "member", "viewer"]);

function inviteLink(req: NextApiRequest, token: string): string {
  const origin = `${String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]}://${String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000").split(",")[0]}`;
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

/** Email an invitation from one of the workspace's own mailboxes. Says why when it could not. */
async function emailInvitation(workspaceId: string, to: string, role: string, inviteUrl: string): Promise<{ sent: boolean; warning: string | null }> {
  const db = getDb();
  const account = db.prepare(`SELECT id,from_email,from_name,reply_to,smtp_host,smtp_port,smtp_secure,username,password
    FROM email_accounts WHERE workspace_id=? ORDER BY is_verified DESC,created_at LIMIT 1`).get(workspaceId) as EmailAccount | undefined;
  if (!account) return { sent: false, warning: "No email sender is configured; copy and share the invitation link manually." };
  const workspace = db.prepare("SELECT name FROM workspaces WHERE id=?").get(workspaceId) as { name: string };
  try {
    await sendEmail(account, to, `You're invited to ${workspace.name} on Linki`,
      `You've been invited to collaborate on outreach in ${workspace.name} as ${role}.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 7 days.`);
    return { sent: true, warning: null };
  } catch (error) {
    return { sent: false, warning: error instanceof Error ? error.message : String(error) };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  if (req.method === "GET") return res.json({ invitations: listWorkspaceInvitations(ctx.workspaceId) });
  if (req.method === "POST") {
    const { email, role = "member", send_email = true } = req.body as { email?: string; role?: WorkspaceRole; send_email?: boolean };
    if (!email || !ROLES.has(role)) return res.status(400).json({ error: "Valid email and role are required" });
    if (role === "owner" && ctx.role !== "owner") return res.status(403).json({ error: "Only an owner can invite another owner" });
    try {
      const created = createWorkspaceInvitation({ workspaceId: ctx.workspaceId, email, role, invitedBy: ctx.userId });
      const inviteUrl = inviteLink(req, created.token);
      const delivery = send_email ? await emailInvitation(ctx.workspaceId, created.invitation.email, role, inviteUrl) : { sent: false, warning: null };
      recordAudit(ctx, "workspace.invitation_created", "workspace_invitation", created.invitation.id, { email: created.invitation.email, role, email_sent: delivery.sent });
      return res.status(201).json({ ...created.invitation, invite_url: inviteUrl, email_sent: delivery.sent, delivery_warning: delivery.warning });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }
  // A new link for an invitation that is still waiting (or has run out): to copy, or to send again.
  if (req.method === "PUT") {
    const { id, send_email = false } = (req.body ?? {}) as { id?: string; send_email?: boolean };
    if (!id || typeof id !== "string") return res.status(400).json({ error: "id is required" });
    const reissued = reissueWorkspaceInvitation(id, ctx.workspaceId, { sent: Boolean(send_email) });
    if (!reissued) return res.status(404).json({ error: "That invitation is no longer waiting. Invite the person again." });
    const inviteUrl = inviteLink(req, reissued.token);
    const delivery = send_email ? await emailInvitation(ctx.workspaceId, reissued.invitation.email, reissued.invitation.role, inviteUrl) : { sent: false, warning: null };
    recordAudit(ctx, send_email ? "workspace.invitation_resent" : "workspace.invitation_link_renewed", "workspace_invitation", id, { email: reissued.invitation.email, email_sent: delivery.sent });
    return res.json({ ...reissued.invitation, invite_url: inviteUrl, email_sent: delivery.sent, delivery_warning: delivery.warning });
  }
  if (req.method === "DELETE") {
    const id = String(req.query.id ?? "");
    if (!id) return res.status(400).json({ error: "id is required" });
    if (!revokeWorkspaceInvitation(id, ctx.workspaceId)) return res.status(404).json({ error: "Pending invitation not found" });
    recordAudit(ctx, "workspace.invitation_revoked", "workspace_invitation", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
