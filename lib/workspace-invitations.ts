import { createHash, randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import type { WorkspaceRole } from "@/lib/workspace";

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60_000;

export type InvitationView = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  email: string;
  role: WorkspaceRole;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_sent_at: string | null;
  invited_by_email: string | null;
  existing_user: boolean;
  status: "pending" | "accepted" | "revoked" | "expired";
};

type InvitationRow = Omit<InvitationView, "status"> & { token_hash: string };

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createWorkspaceInvitation(input: {
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  invitationId?: string;
}): { invitation: InvitationView; token: string } {
  const db = getDb();
  const email = normalizeInvitationEmail(input.email);
  const currentMember = db.prepare(`SELECT 1 FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND lower(u.email)=?`).get(input.workspaceId, email);
  if (currentMember) throw new Error("This user is already a workspace member");

  const token = `linki_inv_${randomBytes(32).toString("base64url")}`;
  const id = input.invitationId ?? randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE workspace_invitations SET revoked_at=datetime('now')
      WHERE workspace_id=? AND lower(email)=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(input.workspaceId, email);
    db.prepare(`INSERT INTO workspace_invitations
      (id,workspace_id,email,role,token_hash,invited_by,expires_at,last_sent_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(id, input.workspaceId, email, input.role, invitationTokenHash(token), input.invitedBy, expiresAt);
  })();
  return { invitation: getInvitationById(id, input.workspaceId)!, token };
}

export function getInvitationByToken(token: string): InvitationView | null {
  const row = getDb().prepare(invitationQuery("WHERE wi.token_hash=?")).get(invitationTokenHash(token)) as InvitationRow | undefined;
  return row ? view(row) : null;
}

export function getInvitationById(id: string, workspaceId: string): InvitationView | null {
  const row = getDb().prepare(invitationQuery("WHERE wi.id=? AND wi.workspace_id=?")).get(id, workspaceId) as InvitationRow | undefined;
  return row ? view(row) : null;
}

export function listWorkspaceInvitations(workspaceId: string): InvitationView[] {
  return (getDb().prepare(invitationQuery("WHERE wi.workspace_id=? ORDER BY wi.created_at DESC")).all(workspaceId) as InvitationRow[]).map(view);
}

export function acceptWorkspaceInvitation(token: string, userId: string, userEmail: string): InvitationView {
  const invitation = getInvitationByToken(token);
  if (!invitation) throw new Error("Invitation not found");
  if (invitation.status !== "pending") throw new Error(`Invitation is ${invitation.status}`);
  if (normalizeInvitationEmail(userEmail) !== invitation.email) throw new Error("Sign in with the invited email address");
  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role`).run(invitation.workspace_id, userId, invitation.role);
    const changed = db.prepare(`UPDATE workspace_invitations SET accepted_by=?,accepted_at=datetime('now')
      WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`).run(userId, invitation.id);
    if (!changed.changes) throw new Error("Invitation is no longer valid");
    db.prepare(`INSERT INTO audit_logs (id,workspace_id,user_id,action,entity_type,entity_id,metadata_json)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), invitation.workspace_id, userId, "workspace.invitation_accepted", "workspace_invitation", invitation.id, JSON.stringify({ email: invitation.email, role: invitation.role }));
  })();
  return getInvitationById(invitation.id, invitation.workspace_id)!;
}

export function revokeWorkspaceInvitation(id: string, workspaceId: string): boolean {
  return getDb().prepare(`UPDATE workspace_invitations SET revoked_at=datetime('now')
    WHERE id=? AND workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(id, workspaceId).changes > 0;
}

function invitationQuery(where: string): string {
  return `SELECT wi.*,w.name workspace_name,inviter.email invited_by_email,
    EXISTS(SELECT 1 FROM users u WHERE lower(u.email)=lower(wi.email)) existing_user
    FROM workspace_invitations wi JOIN workspaces w ON w.id=wi.workspace_id
    LEFT JOIN users inviter ON inviter.id=wi.invited_by ${where}`;
}

function view(row: InvitationRow): InvitationView {
  const status = row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : Date.parse(row.expires_at) <= Date.now() ? "expired" : "pending";
  const { token_hash: _tokenHash, ...safe } = row; void _tokenHash;
  return { ...safe, existing_user: Boolean(row.existing_user), status };
}
