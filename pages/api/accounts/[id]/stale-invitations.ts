import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { staleInvite, staleInviteStats, staleInvites, type StaleInvite } from "@/lib/linkedin/withdrawals";
import { withdrawStaleInvite } from "@/lib/linkedin/stale-invites";
import { canonicalLinkedinUrl } from "@/lib/linkedin/url";
import { firstIssue } from "@/lib/validation";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { refuseIfPaused } from "@/lib/linkedin/pause";

/**
 * The stale-invitation clean-up for one LinkedIn account: what it has to do, what it has
 * done, and a way to do a few now.
 *
 *   GET  /api/accounts/{id}/stale-invitations
 *     → { enabled, waiting, withdrawn_today, daily_limit, withdrawn_by_cleanup, on_hold,
 *         next: [{ contact_id, name, url, requested_at }] }      the next few it would take
 *
 *   POST /api/accounts/{id}/stale-invitations
 *     { confirm: true, limit?: 1-3 }             withdraw the next few now
 *     { confirm: true, contact_ids: [...] }      withdraw exactly these (each must be stale)
 *
 * A stale invitation is one this app sent more than LINKEDIN_ACCEPT_WAIT_DAYS ago, that
 * was never accepted, to a contact no live campaign is still working on and who has not
 * replied (lib/linkedin/withdrawals.ts). The automatic clean-up takes them a few a day
 * when the account's `withdraw_stale_invites` switch is on (PUT /api/accounts/{id}).
 *
 * POST is a person deciding, so it works whether or not that switch is on and outside
 * working hours. It still really withdraws — hence admin and `confirm` — and it still
 * stays inside the account's daily withdrawal limit, which it shares with the campaigns.
 */
const MAX_PER_REQUEST = 3;

const bodySchema = z.object({
  confirm: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_PER_REQUEST).optional(),
  contact_ids: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PER_REQUEST).optional(),
});

const preview = (c: StaleInvite) => ({ contact_id: c.id, name: c.full_name, url: canonicalLinkedinUrl(c.linkedin_url), requested_at: c.connection_requested_at });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin"); if (!ctx) return;

  const accountId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", accountId)) return;
  const db = getDb();
  const account = db.prepare("SELECT is_authenticated, timezone, withdraw_stale_invites FROM accounts WHERE id = ? AND workspace_id = ?").get(accountId, ctx.workspaceId) as
    | { is_authenticated: number; timezone: string | null; withdraw_stale_invites: number }
    | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });

  const summary = () => ({
    enabled: account.withdraw_stale_invites === 1,
    ...staleInviteStats(db, accountId, account.timezone),
    next: staleInvites(db, accountId, 5).map(preview),
  });

  if (req.method === "GET") return res.json(summary());

  if (!account.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });
  if (refuseIfPaused(db, accountId, res)) return;
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
  if (parsed.data.confirm !== true) {
    return res.status(400).json({ error: "This really withdraws invitations on this LinkedIn account — pass confirm: true" });
  }

  // Exactly the contacts asked for, or the next few in line.
  const results: Array<{ contact_id: string; name: string | null; outcome: string }> = [];
  let chosen: StaleInvite[];
  if (parsed.data.contact_ids) {
    chosen = [];
    for (const id of [...new Set(parsed.data.contact_ids)]) {
      const contact = staleInvite(db, accountId, id);
      if (contact) chosen.push(contact);
      else results.push({ contact_id: id, name: null, outcome: "not_stale" });
    }
  } else {
    chosen = staleInvites(db, accountId, parsed.data.limit ?? 1);
  }

  let signedOut = false;
  for (const [index, contact] of chosen.entries()) {
    const stats = staleInviteStats(db, accountId, account.timezone);
    if (stats.withdrawn_today >= stats.daily_limit) {
      results.push({ contact_id: contact.id, name: contact.full_name, outcome: "daily_limit_reached" });
      continue;
    }
    // Not one straight after another: a short, uneven pause between profiles.
    if (index > 0) await pause(4_000 + Math.random() * 5_000);
    const outcome = await withdrawStaleInvite(db, accountId, contact);
    results.push({ contact_id: contact.id, name: contact.full_name, outcome });
    if (outcome === "signed_out") { signedOut = true; break; }
    // LinkedIn said it withdrew this one and did not. It will say the same for the next.
    if (outcome === "unconfirmed") {
      for (const rest of chosen.slice(index + 1)) results.push({ contact_id: rest.id, name: rest.full_name, outcome: "not_attempted" });
      break;
    }
  }

  recordAudit(ctx, "account.stale_invites_withdrawn", "account", accountId, { results: results.map(({ contact_id, outcome }) => ({ contact_id, outcome })) });
  if (signedOut) {
    return res.status(409).json({ ok: false, error: "The LinkedIn session has expired. Sign it in again on the LinkedIn accounts page.", results });
  }
  return res.json({ ok: true, results, ...summary() });
}
