import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";

export interface InboxReply {
  id: string;
  full_name: string | null;
  linkedin_url: string | null;
  email: string | null;
  headline: string | null;
  company: string | null;
  channel: "email" | "linkedin" | "both";
  replied_at: string;
  email_replied_at: string | null;
  last_replied_at: string | null;
  // run context
  run_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  // email account context
  email_account_id: string | null;
  email_account_name: string | null;
  email_account_from: string | null;
  // classifier / dispatcher context (from the most recent email_replies row)
  reply_id: string | null;
  reply_kind: string | null;
  reply_summary: string | null;
  reply_body: string | null;
  classified_at: string | null;
  classification_error: string | null;
  dispatched_at: string | null;
  dispatch_result_json: string | null;
  manually_edited: number;
  assigned_to: string | null;
  assignee_email: string | null;
  inbox_status: string | null;
  sentiment: string | null;
  sla_due_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const ctx = requireWorkspace(req, res);
  if (!ctx) return;

  const db = getDb();
  const channel = req.query.channel as string | undefined; // "email" | "linkedin" | undefined

  // A target shows in the inbox if it has a reply stamp OR a captured email_replies row.
  // OOO-followup replies intentionally leave email_replied_at NULL, so we must include
  // the email_replies source to keep scheduled follow-ups visible.
  let channelFilter =
    "AND (t.email_replied_at IS NOT NULL OR t.last_replied_at IS NOT NULL OR er.id IS NOT NULL)";
  if (channel === "email") channelFilter = "AND (t.email_replied_at IS NOT NULL OR er.id IS NOT NULL)";
  if (channel === "linkedin") channelFilter = "AND t.last_replied_at IS NOT NULL";

  const filters: string[] = [];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof req.query.status === "string" && req.query.status) { filters.push("AND COALESCE(er.inbox_status, 'open') = ?"); params.push(req.query.status); }
  if (typeof req.query.sentiment === "string" && req.query.sentiment) { filters.push("AND er.sentiment = ?"); params.push(req.query.sentiment); }
  if (typeof req.query.assigned_to === "string" && req.query.assigned_to) { filters.push("AND er.assigned_to = ?"); params.push(req.query.assigned_to); }
  if (req.query.sla === "overdue") filters.push("AND er.sla_due_at < datetime('now') AND COALESCE(er.inbox_status, 'open') NOT IN ('resolved','closed')");
  if (typeof req.query.tag_id === "string" && req.query.tag_id) { filters.push("AND EXISTS (SELECT 1 FROM email_reply_tags ertf WHERE ertf.reply_id=er.id AND ertf.tag_id=?)"); params.push(req.query.tag_id); }

  const rows = db.prepare(`
    SELECT
      t.id,
      t.full_name,
      t.linkedin_url,
      t.email,
      t.headline,
      t.company,
      t.email_replied_at,
      t.last_replied_at,
      CASE
        WHEN (t.email_replied_at IS NOT NULL OR er.id IS NOT NULL) AND t.last_replied_at IS NOT NULL THEN 'both'
        WHEN t.email_replied_at IS NOT NULL OR er.id IS NOT NULL THEN 'email'
        ELSE 'linkedin'
      END AS channel,
      MAX(
        COALESCE(t.email_replied_at, ''),
        COALESCE(t.last_replied_at, ''),
        COALESCE(er.received_at, '')
      ) AS replied_at,
      r.id AS run_id,
      r.workflow_id,
      w.name AS workflow_name,
      ea.id AS email_account_id,
      ea.name AS email_account_name,
      ea.from_email AS email_account_from,
      er.id AS reply_id,
      er.classification_json AS classification_json,
      er.body_text AS reply_body,
      er.classified_at,
      er.classification_error,
      er.dispatched_at,
      er.dispatch_result_json,
      COALESCE(er.manually_edited, 0) AS manually_edited,
      er.assigned_to,
      assignee.email AS assignee_email,
      er.inbox_status,
      er.sentiment,
      er.sla_due_at,
      er.locked_by,
      er.locked_at,
      COALESCE((SELECT json_group_array(json_object('id', it.id, 'name', it.name, 'color', it.color))
        FROM email_reply_tags ert JOIN inbox_tags it ON it.id=ert.tag_id WHERE ert.reply_id=er.id), '[]') AS tags_json
    FROM targets t
    LEFT JOIN run_profiles rp ON rp.target_id = t.id
    LEFT JOIN runs r ON r.id = rp.run_id AND r.status IN ('running', 'paused', 'completed')
    LEFT JOIN workflows w ON w.id = r.workflow_id
    LEFT JOIN (
      SELECT er1.* FROM email_replies er1
      WHERE er1.received_at = (
        SELECT MAX(er2.received_at) FROM email_replies er2 WHERE er2.target_id = er1.target_id
      )
    ) er ON er.target_id = t.id
    LEFT JOIN email_accounts ea ON ea.id = COALESCE(er.email_account_id, rp.email_account_id)
    LEFT JOIN users assignee ON assignee.id = er.assigned_to
    WHERE t.workspace_id = ?
    ${channelFilter}
    ${filters.join("\n")}
    GROUP BY t.id
    ORDER BY replied_at DESC
  `).all(...params) as Array<InboxReply & { classification_json: string | null; tags_json: string }>;

  const replies: InboxReply[] = rows.map((row) => {
    let reply_kind: string | null = null;
    let reply_summary: string | null = null;
    if (row.classification_json) {
      try {
        const cls = JSON.parse(row.classification_json) as { kind?: string; summary?: string };
        reply_kind = cls.kind ?? null;
        reply_summary = cls.summary ?? null;
      } catch { /* malformed — leave null */ }
    }
    const { classification_json: _omit, tags_json, ...rest } = row;
    void _omit;
    let tags: Array<{ id: string; name: string; color: string }> = [];
    try { tags = JSON.parse(tags_json) as typeof tags; } catch { /* malformed aggregate */ }
    return { ...rest, reply_kind, reply_summary, tags };
  });

  return res.json({ replies });
}
