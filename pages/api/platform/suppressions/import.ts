import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { addSuppression, normalizeSuppression, type SuppressionKind } from "@/lib/platform/suppression";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const MAX_ENTRIES = 5000;

/** What a pasted line is, when the caller did not say: an address, a profile, a phone number, a domain, or nothing usable. */
export function detectSuppressionKind(value: string): SuppressionKind | null {
  const text = value.trim();
  if (!text) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "email";
  if (/linkedin\.com\/(in|sales\/lead|company)\//i.test(text)) return "linkedin";
  if (/^\+?[\d\s().-]{7,}$/.test(text) && text.replace(/\D/g, "").length >= 7) return "phone";
  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(text)) return "domain";
  return null;
}

/**
 * POST { entries, kind?, reason? } → add many do-not-contact entries at once.
 *
 * `entries` is a list, or text with one entry per line (a pasted column or a CSV: the
 * first cell of each line is taken). `kind` is email, domain, linkedin or phone; left out,
 * each line's kind is worked out from what it looks like. Lines that are nothing usable
 * are reported back, not guessed at.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", ["POST"]); return res.status(405).end(); }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const body = (req.body ?? {}) as { entries?: unknown; kind?: string; reason?: string };
  const fixedKind = body.kind && body.kind !== "auto" ? body.kind : null;
  if (fixedKind && !["email", "domain", "linkedin", "phone"].includes(fixedKind)) return res.status(400).json({ error: "kind must be email, domain, linkedin or phone" });
  const lines = (Array.isArray(body.entries) ? body.entries.map(String) : String(body.entries ?? "").split(/\r?\n/))
    .map((line) => line.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, ""))
    .filter((line) => line && !/^(email|domain|value|address|linkedin|phone)$/i.test(line));
  if (lines.length === 0) return res.status(400).json({ error: "Nothing to import" });
  if (lines.length > MAX_ENTRIES) return res.status(400).json({ error: `At most ${MAX_ENTRIES} entries at a time` });

  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM suppressions WHERE workspace_id = ? AND kind = ? AND value = ?");
  const reason = String(body.reason ?? "").trim() || "imported";
  const result = { added: 0, already_listed: 0, invalid: [] as string[] };
  db.transaction(() => {
    for (const line of lines) {
      const kind = (fixedKind as SuppressionKind | null) ?? detectSuppressionKind(line);
      // A fixed kind still has to look like one: "not an email" is not a suppressed email.
      if (!kind || (fixedKind === "email" && detectSuppressionKind(line) !== "email")) { if (result.invalid.length < 50) result.invalid.push(line); continue; }
      if (exists.get(ctx.workspaceId, kind, normalizeSuppression(kind, line))) { result.already_listed++; continue; }
      addSuppression({ workspaceId: ctx.workspaceId, kind, value: line, reason, source: "import", createdBy: ctx.userId ?? undefined });
      result.added++;
    }
  })();
  recordAudit(ctx, "suppression.imported", "suppression", undefined, { added: result.added, already_listed: result.already_listed, invalid: lines.length - result.added - result.already_listed });
  return res.status(201).json(result);
}
