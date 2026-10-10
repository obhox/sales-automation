import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { unreadNotificationCount } from "@/lib/platform/notifications";
import { capabilities } from "@/lib/premium";
import { readRunnerHealth } from "@/lib/system/health";
import { getUpdateState } from "@/lib/update-check";
import { getMemberships, requireWorkspace } from "@/lib/workspace";
import { settleConversations, unreadCount } from "@/lib/conversations/store";

// Everything the frame around every page needs, in one request: who is signed in, which
// workspaces they can switch to, the badge counts, whether the background work is
// running, and the version. The sidebar polls this; it must stay cheap.

export interface ShellPayload {
  user: { id: string; email: string; name: string; role: string };
  workspace: { id: string; name: string };
  workspaces: { id: string; name: string; role: string }[];
  counts: { inbox: number; tasks: number; signals: number; notifications: number };
  health: { status: string; summary: string };
  version: { current: string; latest: string | null; update_available: boolean };
  /** Which optional parts of the product this build includes (CRM, AI writing, MCP …). */
  capabilities: Record<string, boolean>;
}

/** "jordan.mertens" → "Jordan Mertens", for members who have not set a name. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local.split(/[._\-+]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "The app frame is for signed-in members" });
  const db = getDb();

  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(ctx.userId) as { id: string; email: string; name: string | null } | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const workspace = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(ctx.workspaceId) as { id: string; name: string };

  // What the inbox badge counts: open conversations whose latest message from the contact
  // this member has not read. Snoozes that have run out are opened first, so the count
  // moves when the clock does and not only when somebody opens the inbox.
  settleConversations(db, ctx.workspaceId);
  const inbox = unreadCount(db, ctx.workspaceId, ctx.userId);
  const tasks = (db.prepare("SELECT COUNT(*) AS c FROM todos WHERE workspace_id = ? AND status = 'open'").get(ctx.workspaceId) as { c: number }).c;
  const signals = (db.prepare("SELECT COUNT(*) AS c FROM signals WHERE workspace_id = ? AND processed_at IS NULL").get(ctx.workspaceId) as { c: number }).c;

  const health = readRunnerHealth(db);
  const update = getUpdateState();

  const payload: ShellPayload = {
    user: { id: user.id, email: user.email, name: user.name?.trim() || nameFromEmail(user.email), role: ctx.role },
    workspace,
    workspaces: (getMemberships(ctx.userId) as { id: string; name: string; role: string }[]).map(({ id, name, role }) => ({ id, name, role })),
    counts: { inbox, tasks, signals, notifications: unreadNotificationCount(ctx.workspaceId, ctx.userId, ctx.role, db) },
    // Which loop is behind is for admins on the developer page; everyone sees only whether all is well.
    health: { status: health.status, summary: health.status === "degraded" && ctx.role !== "owner" && ctx.role !== "admin" ? "Background work is delayed" : health.summary },
    version: { current: update.current, latest: update.latest ?? null, update_available: Boolean(update.updateAvailable) },
    capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, enabled]) => [name, Boolean(enabled)])),
  };
  return res.json(payload);
}
