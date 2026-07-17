import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendEmail, type EmailAccount } from "@/lib/email/sender";
import { requireWorkspace, recordAudit, type WorkspaceRole } from "@/lib/workspace";
import { createWorkspaceInvitation, listWorkspaceInvitations, revokeWorkspaceInvitation } from "@/lib/workspace-invitations";

const ROLES = new Set<WorkspaceRole>(["owner", "admin", "manager", "member", "viewer"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") return res.json({ invitations: listWorkspaceInvitations(ctx.workspaceId) });
  if (req.method === "POST") {
    const { email, role = "member", send_email = true } = req.body as { email?: string; role?: WorkspaceRole; send_email?: boolean };
    if (!email || !ROLES.has(role)) return res.status(400).json({ error: "Valid email and role are required" });
    if (role === "owner" && ctx.role !== "owner") return res.status(403).json({ error: "Only an owner can invite another owner" });
    try {
      const created = createWorkspaceInvitation({ workspaceId: ctx.workspaceId, email, role, invitedBy: ctx.userId });
      const origin = `${String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]}://${String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000").split(",")[0]}`;
      const inviteUrl = `${origin}/invite/${encodeURIComponent(created.token)}`;
      let emailSent = false;
      let deliveryWarning: string | null = null;
      if (send_email) {
        const account = db.prepare(`SELECT id,from_email,from_name,reply_to,smtp_host,smtp_port,smtp_secure,username,password
          FROM email_accounts WHERE workspace_id=? ORDER BY is_verified DESC,created_at LIMIT 1`).get(ctx.workspaceId) as EmailAccount | undefined;
        if (account) {
          const workspace = db.prepare("SELECT name FROM workspaces WHERE id=?").get(ctx.workspaceId) as { name: string };
          try {
            await sendEmail(account, created.invitation.email, `You're invited to ${workspace.name} on Linki`,
              `You've been invited to collaborate on outreach in ${workspace.name} as ${role}.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 7 days.`);
            emailSent = true;
          } catch (error) { deliveryWarning = error instanceof Error ? error.message : String(error); }
        } else deliveryWarning = "No email sender is configured; copy and share the invitation link manually.";
      }
      recordAudit(ctx, "workspace.invitation_created", "workspace_invitation", created.invitation.id, { email: created.invitation.email, role, email_sent: emailSent });
      return res.status(201).json({ ...created.invitation, invite_url: inviteUrl, email_sent: emailSent, delivery_warning: deliveryWarning });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
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
