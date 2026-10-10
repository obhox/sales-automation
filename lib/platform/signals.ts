import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { emitDomainEvent } from "@/lib/platform/events";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { assignEmailAccounts, enrollTargets, workflowTracks } from "@/lib/outreach/enroll";

export function ingestSignal(input: { workspaceId: string; targetId?: string; companyId?: string; type: string; title: string; description?: string; score?: number; source?: string; occurredAt?: string; metadata?: unknown }) {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`INSERT INTO signals (id, workspace_id, target_id, company_id, type, title, description, score, source, occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workspaceId, input.targetId ?? null, input.companyId ?? null, input.type, input.title, input.description ?? null, input.score ?? 0, input.source ?? "api", input.occurredAt ?? new Date().toISOString(), JSON.stringify(input.metadata ?? {}));
  if (input.targetId) {
    db.prepare("UPDATE targets SET intent_score = MIN(100, MAX(intent_score, ?) + ?) WHERE id = ? AND workspace_id = ?")
      .run(input.score ?? 0, Math.max(0, Number(input.score ?? 0) * 0.1), input.targetId, input.workspaceId);
    applySignalRules(input.workspaceId, input.targetId, input.type, input.score ?? 0);
  }
  emitDomainEvent({ workspaceId: input.workspaceId, type: "signal.received", entityType: "signal", entityId: id, payload: input });
  return db.prepare("SELECT * FROM signals WHERE id = ?").get(id);
}

function applySignalRules(workspaceId: string, targetId: string, type: string, score: number) {
  const db = getDb();
  const rules = db.prepare(`SELECT * FROM signal_rules WHERE workspace_id = ? AND enabled = 1
    AND signal_type = ? AND min_score <= ?`).all(workspaceId, type, score) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    // Isolate each rule: a single misconfigured rule (e.g. a workflow deleted out from under
    // it, or a bad reference) must not abort the loop or break signal ingestion for the rest.
    try {
      if (rule.list_id) db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(rule.list_id, targetId);
      if (!rule.workflow_id || !rule.list_id) continue;
      // The campaign decides which senders the rule must name: a LinkedIn account when it
      // has LinkedIn steps, a mailbox when it has none. A rule missing what its campaign
      // needs, or pointing at something since deleted, enrols nobody rather than starting a
      // run that cannot do its work.
      const refsOk = db.prepare(`SELECT
          EXISTS(SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?) w,
          EXISTS(SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?) l,
          EXISTS(SELECT 1 FROM accounts WHERE id = ? AND workspace_id = ?) a,
          EXISTS(SELECT 1 FROM email_accounts WHERE id = ? AND workspace_id = ?) e`)
        .get(rule.workflow_id, workspaceId, rule.list_id, workspaceId, rule.account_id ?? null, workspaceId, rule.email_account_id ?? null, workspaceId) as { w: number; l: number; a: number; e: number };
      if (!refsOk.w || !refsOk.l) continue;
      const tracks = workflowTracks(db, String(rule.workflow_id));
      const linkedinAccountId = refsOk.a ? String(rule.account_id) : null;
      const mailboxId = refsOk.e ? String(rule.email_account_id) : null;
      if (tracks.includes("linkedin") ? !linkedinAccountId : !mailboxId) continue;

      let run = db.prepare("SELECT id, status FROM runs WHERE workspace_id = ? AND workflow_id = ? AND status IN ('pending','running','paused') ORDER BY created_at DESC LIMIT 1").get(workspaceId, rule.workflow_id) as { id: string; status: string } | undefined;
      db.transaction(() => {
        if (!run) {
          run = { id: randomUUID(), status: Number(rule.auto_start) ? "running" : "pending" };
          db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, account_id, email_account_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(run.id, workspaceId, rule.workflow_id, rule.list_id, linkedinAccountId, mailboxId, run.status, run.status === "running" ? new Date().toISOString() : null);
        }
        if (db.prepare("SELECT 1 FROM run_profiles WHERE run_id = ? AND target_id = ?").get(run.id, targetId)) return;
        // The rule's mailbox, or one the run is already sending from, so a contact enrolled
        // by a signal gets the campaign's emails as well as its LinkedIn steps.
        const pool = mailboxId ? [mailboxId] : (db.prepare("SELECT DISTINCT email_account_id FROM run_profiles WHERE run_id = ? AND email_account_id IS NOT NULL").all(run.id) as Array<{ email_account_id: string }>).map((row) => row.email_account_id);
        enrollTargets(db, run.id, tracks, [targetId], assignEmailAccounts(db, [targetId], pool));
      })();
      if (!run) continue;
      if (run.status === "running") ensureGlobalRunnerStarted();
    } catch (err) {
      console.warn(`[signals] rule ${String(rule.id)} failed to apply:`, err instanceof Error ? err.message : err);
    }
  }
}

