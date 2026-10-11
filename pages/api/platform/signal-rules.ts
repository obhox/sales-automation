import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { SIGNAL_TYPES } from "@/lib/platform/signal-types";
import { signalRuleProblem, type SignalRuleRefs } from "@/lib/platform/signal-rules";

type Body = Record<string, unknown>;
type RuleRow = SignalRuleRefs & { id: string; name: string; signal_type: string; min_score: number; enabled: number; auto_start: number };

const REFS = [["list_id", "lists", "List"], ["workflow_id", "workflows", "Campaign"], ["account_id", "accounts", "LinkedIn account"], ["email_account_id", "email_accounts", "Mailbox"]] as const;
const TYPES = new Set<string>(SIGNAL_TYPES);

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;
  const db = getDb();

  /** What the caller sent, checked; a string is the reason it was refused. */
  function fieldsOf(b: Body): Record<string, unknown> | string {
    const set: Record<string, unknown> = {};
    if (b.name !== undefined) {
      set.name = String(b.name).trim();
      if (!set.name) return "name is required";
    }
    if (b.signal_type !== undefined) {
      if (!TYPES.has(String(b.signal_type))) return `signal_type must be one of: ${SIGNAL_TYPES.join(", ")}`;
      set.signal_type = String(b.signal_type);
    }
    if (b.min_score !== undefined) {
      const score = Number(b.min_score ?? 0);
      if (!Number.isFinite(score) || score < 0) return "min_score must be a number, zero or more";
      set.min_score = score;
    }
    for (const [field, table, label] of REFS) {
      if (b[field] === undefined) continue;
      // null or "" clears the link.
      const id = b[field] === null || b[field] === "" ? null : String(b[field]);
      if (id && !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id, ctx!.workspaceId)) return `${label} not found in this workspace`;
      set[field] = id;
    }
    if (b.enabled !== undefined) set.enabled = b.enabled ? 1 : 0;
    if (b.auto_start !== undefined) set.auto_start = b.auto_start ? 1 : 0;
    return set;
  }

  if (req.method === "GET") {
    const rows = db.prepare(`SELECT sr.*,l.name list_name,w.name workflow_name,a.name account_name,ea.name email_account_name
      FROM signal_rules sr LEFT JOIN lists l ON l.id=sr.list_id LEFT JOIN workflows w ON w.id=sr.workflow_id LEFT JOIN accounts a ON a.id=sr.account_id
        LEFT JOIN email_accounts ea ON ea.id=sr.email_account_id
      WHERE sr.workspace_id=? ORDER BY sr.created_at DESC`).all(ctx.workspaceId) as RuleRow[];
    // A list, campaign or account a rule names can be deleted after it was written.
    return res.json(rows.map((rule) => ({ ...rule, problem: signalRuleProblem(db, rule) })));
  }

  if (req.method === "POST") {
    const b = (req.body ?? {}) as Body;
    const set = fieldsOf(b);
    if (typeof set === "string") return res.status(400).json({ error: set });
    if (!set.name || !set.signal_type) return res.status(400).json({ error: "name and signal_type are required" });
    const problem = signalRuleProblem(db, set as SignalRuleRefs);
    if (problem) return res.status(400).json({ error: problem });
    const id = randomUUID();
    db.prepare(`INSERT INTO signal_rules (id,workspace_id,name,signal_type,min_score,list_id,workflow_id,account_id,email_account_id,enabled,auto_start)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, ctx.workspaceId, set.name, set.signal_type, set.min_score ?? 0, set.list_id ?? null, set.workflow_id ?? null,
      set.account_id ?? null, set.email_account_id ?? null, set.enabled ?? 1, set.auto_start ?? 0);
    recordAudit(ctx, "signal_rule.created", "signal_rule", id);
    return res.status(201).json(db.prepare("SELECT * FROM signal_rules WHERE id=?").get(id));
  }

  if (req.method === "PATCH") {
    const b = (req.body ?? {}) as Body, id = String(b.id ?? "");
    if (!id) return res.status(400).json({ error: "id is required" });
    const rule = db.prepare("SELECT * FROM signal_rules WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId) as RuleRow | undefined;
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    const set = fieldsOf(b);
    if (typeof set === "string") return res.status(400).json({ error: set });
    const fields = Object.keys(set);
    if (!fields.length) return res.status(400).json({ error: "No fields supplied" });
    // Checked as the rule would stand after the change. Turning a rule off is always
    // allowed, so one that has stopped making sense can be parked rather than deleted.
    const after = { ...rule, ...set } as RuleRow;
    const problem = after.enabled ? signalRuleProblem(db, after) : null;
    if (problem) return res.status(400).json({ error: problem });
    db.prepare(`UPDATE signal_rules SET ${fields.map((x) => `${x}=?`).join(",")} WHERE id=? AND workspace_id=?`).run(...fields.map((x) => set[x]), id, ctx.workspaceId);
    recordAudit(ctx, "signal_rule.updated", "signal_rule", id, { fields });
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id ?? "");
    const removed = db.prepare("DELETE FROM signal_rules WHERE id=? AND workspace_id=?").run(id, ctx.workspaceId).changes;
    if (!removed) return res.status(404).json({ error: "Rule not found" });
    recordAudit(ctx, "signal_rule.deleted", "signal_rule", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
