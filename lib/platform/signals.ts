import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { emitDomainEvent } from "@/lib/platform/events";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";

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
    if (rule.list_id) db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(rule.list_id, targetId);
    if (!rule.workflow_id || !rule.account_id || !rule.list_id) continue;
    let run = db.prepare("SELECT id, status FROM runs WHERE workspace_id = ? AND workflow_id = ? AND status IN ('pending','running','paused') ORDER BY created_at DESC LIMIT 1").get(workspaceId, rule.workflow_id) as { id: string; status: string } | undefined;
    if (!run) {
      run = { id: randomUUID(), status: Number(rule.auto_start) ? "running" : "pending" };
      db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, account_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(run.id, workspaceId, rule.workflow_id, rule.list_id, rule.account_id, run.status, run.status === "running" ? new Date().toISOString() : null);
    }
    const enrolled = db.prepare("SELECT 1 FROM run_profiles WHERE run_id = ? AND target_id = ?").get(run.id, targetId);
    if (!enrolled) {
      const profileId = randomUUID();
      db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profileId, run.id, targetId);
      const tracks = db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(rule.workflow_id) as Array<{ track: string }>;
      const insert = db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'pending', 0)");
      for (const track of tracks.length ? tracks : [{ track: "linkedin" }]) if (track.track !== "email") insert.run(randomUUID(), profileId, track.track);
    }
    if (run.status === "running") ensureGlobalRunnerStarted();
  }
}

