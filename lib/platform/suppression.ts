import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

export type SuppressionKind = "email" | "domain" | "linkedin" | "phone";

export function normalizeSuppression(kind: SuppressionKind, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (kind === "email") return trimmed;
  if (kind === "domain") return trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (kind === "phone") return trimmed.replace(/[^+\d]/g, "");
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch { return trimmed.replace(/\/$/, ""); }
}

export function addSuppression(input: { workspaceId: string; kind: SuppressionKind; value: string; reason: string; source?: string; targetId?: string; createdBy?: string }) {
  const id = randomUUID();
  const value = normalizeSuppression(input.kind, input.value);
  getDb().prepare(`INSERT INTO suppressions
    (id, workspace_id, kind, value, reason, source, target_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, kind, value) DO UPDATE SET reason = excluded.reason, source = excluded.source, target_id = COALESCE(excluded.target_id, target_id)`)
    .run(id, input.workspaceId, input.kind, value, input.reason, input.source ?? null, input.targetId ?? null, input.createdBy ?? null);
  return getDb().prepare("SELECT * FROM suppressions WHERE workspace_id = ? AND kind = ? AND value = ?").get(input.workspaceId, input.kind, value);
}

export function findTargetSuppression(workspaceId: string, targetId: string): { kind: string; value: string; reason: string } | null {
  const target = getDb().prepare("SELECT email, linkedin_url, phone FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, workspaceId) as { email: string | null; linkedin_url: string | null; phone: string | null } | undefined;
  if (!target) return { kind: "target", value: targetId, reason: "Contact is outside the active workspace" };
  const candidates: Array<[SuppressionKind, string]> = [];
  if (target.email) {
    candidates.push(["email", normalizeSuppression("email", target.email)]);
    const domain = target.email.split("@")[1];
    if (domain) candidates.push(["domain", normalizeSuppression("domain", domain)]);
  }
  if (target.linkedin_url) candidates.push(["linkedin", normalizeSuppression("linkedin", target.linkedin_url)]);
  if (target.phone) candidates.push(["phone", normalizeSuppression("phone", target.phone)]);
  for (const [kind, value] of candidates) {
    const row = getDb().prepare("SELECT kind, value, reason FROM suppressions WHERE workspace_id = ? AND kind = ? AND value = ?").get(workspaceId, kind, value) as { kind: string; value: string; reason: string } | undefined;
    if (row) return row;
  }
  return null;
}

export function isAddressSuppressed(workspaceId: string, email: string): { kind: string; value: string; reason: string } | null {
  const normalized = normalizeSuppression("email", email);
  const domain = normalizeSuppression("domain", email.split("@")[1] ?? "");
  return (getDb().prepare(`SELECT kind, value, reason FROM suppressions
    WHERE workspace_id = ? AND ((kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?)) LIMIT 1`)
    .get(workspaceId, normalized, domain) as { kind: string; value: string; reason: string } | undefined) ?? null;
}

