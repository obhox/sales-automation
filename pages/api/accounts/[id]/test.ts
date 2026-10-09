import type { NextApiRequest, NextApiResponse } from "next";
import type { Page } from "playwright";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth, SessionExpiredError, gotoLinkedin } from "@/lib/linkedin/session";
import { checkLinkedinSession } from "@/lib/linkedin/health";
import { visitProfile } from "@/lib/linkedin/visit";
import {
  sendConnectionRequest, readRelation, AlreadyConnectedError, PendingInviteError, WeeklyLimitError, ConnectUnavailableError,
} from "@/lib/linkedin/connect";
import {
  sendMessage, NotConnectedError, RecipientRepliedError, RecipientMismatchError, MessageUnconfirmedError,
} from "@/lib/linkedin/message";
import { canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";
import { firstIssue } from "@/lib/validation";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Run ONE LinkedIn action through the real automation code, on demand, and report exactly
 * what LinkedIn showed.
 *
 *   POST /api/accounts/{id}/test
 *     { action: "session" }                                   is the session signed in?
 *     { action: "inspect", url | contact_id }                 what does the automation read on this profile?
 *     { action: "visit",   url | contact_id }
 *     { action: "connect", url | contact_id, note?, confirm: true }
 *     { action: "message", url | contact_id, text,  confirm: true }
 *
 * This is how a change to the browser steps is proven: the same functions the campaign
 * runner calls, against the live account, one contact at a time — instead of finding out
 * from a campaign's failure log. `connect` and `message` really send, so they need an
 * admin and an explicit `confirm`.
 *
 * With `contact_id` the outcome is recorded on the contact (request sent, message sent),
 * so a campaign that reaches the same step later does not repeat it.
 */
const bodySchema = z.object({
  action: z.enum(["session", "inspect", "visit", "connect", "message"]),
  url: z.string().trim().max(1000).optional(),
  contact_id: z.string().trim().max(100).optional(),
  note: z.string().max(300).optional(),
  text: z.string().max(8000).optional(),
  confirm: z.boolean().optional(),
});

type Outcome = { ok: boolean; action: string; outcome: string; detail?: unknown };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const accountId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", accountId)) return;
  const db = getDb();
  const account = db.prepare("SELECT id, is_authenticated FROM accounts WHERE id = ? AND workspace_id = ?").get(accountId, ctx.workspaceId) as
    | { id: string; is_authenticated: number }
    | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!account.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
  const { action, note, text, confirm } = parsed.data;

  if (action === "session") {
    try {
      const { signedIn, detail } = await checkLinkedinSession(accountId);
      return res.json({ ok: signedIn, action, outcome: signedIn ? "signed_in" : "signed_out", detail } satisfies Outcome);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Session check failed" });
    }
  }

  // Everything else acts on one profile.
  let profileUrl = parsed.data.url ?? null;
  const contactId = parsed.data.contact_id ?? null;
  if (contactId) {
    const contact = db.prepare("SELECT linkedin_url FROM targets WHERE id = ? AND workspace_id = ?").get(contactId, ctx.workspaceId) as
      | { linkedin_url: string | null }
      | undefined;
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    profileUrl = contact.linkedin_url;
  }
  if (!profileUrl || !profileVanity(profileUrl)) {
    return res.status(400).json({ error: "A linkedin.com/in/ profile URL is required (pass url, or a contact_id that has one)" });
  }
  if ((action === "connect" || action === "message") && confirm !== true) {
    return res.status(400).json({ error: `"${action}" really sends from this LinkedIn account — pass confirm: true` });
  }
  if (action === "message" && !text?.trim()) return res.status(400).json({ error: "text is required for a message" });

  let page: Page | undefined;
  const reply = (outcome: Outcome) => res.json(outcome);
  try {
    page = await getSessionPage(accountId);

    if (action === "inspect") {
      // The same reading the connect step does, More menu included — and nothing else.
      await gotoLinkedin(page, canonicalLinkedinUrl(profileUrl));
      const { card, relation, inviteHref, via } = await readRelation(page);
      return reply({
        ok: true, action, outcome: relation,
        detail: { url: canonicalLinkedinUrl(profileUrl), name: card.name, degree: card.degree, relation, found_via: via, can_invite: !!inviteHref, can_message: relation === "connected" && !!card.messageHref },
      });
    }

    if (action === "visit") {
      await visitProfile(page, profileUrl);
      return reply({ ok: true, action, outcome: "visited" });
    }

    if (action === "connect") {
      const result = await sendConnectionRequest(page, profileUrl, { note });
      if (contactId) db.prepare("UPDATE targets SET connection_requested_at = COALESCE(connection_requested_at, ?) WHERE id = ?").run(new Date().toISOString(), contactId);
      recordAudit(ctx, "account.test_connect", "account", accountId, { url: canonicalLinkedinUrl(profileUrl), contact_id: contactId, note_sent: result.noteSent });
      return reply({ ok: true, action, outcome: "invitation_pending", detail: result });
    }

    const delivery = await sendMessage(page, profileUrl, text!);
    if (contactId) db.prepare("UPDATE targets SET message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?").run(new Date().toISOString(), contactId);
    recordAudit(ctx, "account.test_message", "account", accountId, { url: canonicalLinkedinUrl(profileUrl), contact_id: contactId, delivery });
    return reply({ ok: true, action, outcome: delivery === "sent" ? "message_sent" : "already_sent" });
  } catch (err) {
    // The states LinkedIn can legitimately be in are answers, not server errors.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SessionExpiredError) {
      await markNeedsReauth(accountId).catch(() => {});
      return res.status(409).json({ ok: false, action, outcome: "signed_out", detail: message });
    }
    if (err instanceof AlreadyConnectedError) return reply({ ok: false, action, outcome: "already_connected" });
    if (err instanceof PendingInviteError) {
      if (contactId) db.prepare("UPDATE targets SET connection_requested_at = COALESCE(connection_requested_at, ?) WHERE id = ?").run(new Date().toISOString(), contactId);
      return reply({ ok: false, action, outcome: "invitation_already_pending" });
    }
    if (err instanceof WeeklyLimitError) return reply({ ok: false, action, outcome: "weekly_limit_reached" });
    if (err instanceof ConnectUnavailableError) return reply({ ok: false, action, outcome: "connect_unavailable", detail: message });
    if (err instanceof NotConnectedError) return reply({ ok: false, action, outcome: err.relation === "pending" ? "invitation_still_pending" : "not_connected", detail: { degree: err.degree } });
    if (err instanceof RecipientRepliedError) return reply({ ok: false, action, outcome: "contact_has_replied" });
    if (err instanceof RecipientMismatchError) return reply({ ok: false, action, outcome: "recipient_not_confirmed", detail: message });
    if (err instanceof MessageUnconfirmedError) return reply({ ok: false, action, outcome: "send_unconfirmed", detail: message });
    console.error(`[linkedin-test] ${action} failed:`, message);
    return res.status(500).json({ ok: false, action, outcome: "error", detail: message });
  } finally {
    await page?.close().catch(() => {});
    await saveSessionState(accountId).catch(() => {});
  }
}
