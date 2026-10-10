import type { NextApiRequest, NextApiResponse } from "next";
import type { Page } from "playwright";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth, SessionExpiredError, gotoLinkedin } from "@/lib/linkedin/session";
import { checkLinkedinSession } from "@/lib/linkedin/health";
import { visitProfile } from "@/lib/linkedin/visit";
import {
  sendConnectionRequest, readRelation, AlreadyConnectedError, PendingInviteError, WeeklyLimitError, ConnectUnavailableError, InviteBlockedError,
} from "@/lib/linkedin/connect";
import {
  sendMessage, NotConnectedError, RecipientRepliedError, RecipientMismatchError, MessageUnconfirmedError,
} from "@/lib/linkedin/message";
import { withdrawInvitation, NoPendingInviteError, WithdrawUnconfirmedError } from "@/lib/linkedin/withdraw";
import { recordWithdrawal } from "@/lib/linkedin/withdrawals";
import { canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";
import { readLinkedinThread, syncLinkedinInbox } from "@/lib/linkedin/inbox-sync";
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
 *     { action: "connect",  url | contact_id, note?, confirm: true }
 *     { action: "message",  url | contact_id, text,  confirm: true }
 *     { action: "withdraw", url | contact_id,        confirm: true }
 *     { action: "inbox" }                                      what would a read of the inbox find? (stores nothing)
 *     { action: "inbox", apply: true }                         read it now, as the scheduled read does
 *     { action: "thread", contact_id }                         one contact's conversation, live (stores nothing)
 *
 * `inbox` and `thread` only read, and cannot mark anything read: every request to
 * LinkedIn's messaging that is not a plain read is dropped while they work. They report
 * conversations with contacts of this workspace and only count the rest.
 *
 * This is how a change to the browser steps is proven: the same functions the campaign
 * runner calls, against the live account, one contact at a time — instead of finding out
 * from a campaign's failure log. `connect` and `message` really send and `withdraw` really
 * takes an invitation back, so they need an admin and an explicit `confirm`.
 *
 * With `contact_id` the outcome is recorded on the contact (request sent, message sent,
 * invitation withdrawn), so a campaign that reaches the same step later does not repeat it.
 * A withdrawal recorded this way is one a later connect step waits out: LinkedIn refuses a
 * new invitation to that member for about three weeks.
 */
const bodySchema = z.object({
  action: z.enum(["session", "inspect", "visit", "connect", "message", "withdraw", "inbox", "thread"]),
  url: z.string().trim().max(1000).optional(),
  contact_id: z.string().trim().max(100).optional(),
  note: z.string().max(300).optional(),
  text: z.string().max(8000).optional(),
  confirm: z.boolean().optional(),
  apply: z.boolean().optional(),
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

  if (action === "inbox") {
    try {
      const read = await syncLinkedinInbox(accountId, { dryRun: parsed.data.apply !== true });
      return res.json({ ok: !read.signedOut, action, outcome: read.signedOut ? "signed_out" : read.dry_run ? "dry_run" : "read", detail: read } satisfies Outcome);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "The inbox could not be read" });
    }
  }
  if (action === "thread") {
    const threadContact = parsed.data.contact_id;
    if (!threadContact || !db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(threadContact, ctx.workspaceId)) return res.status(404).json({ error: "Contact not found" });
    try {
      const read = await readLinkedinThread(accountId, threadContact);
      return res.json({ ok: !read.signedOut && read.found, action, outcome: read.signedOut ? "signed_out" : read.found ? "read" : "no_conversation", detail: read } satisfies Outcome);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "The conversation could not be read" });
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
  if (action === "withdraw" && confirm !== true) {
    return res.status(400).json({ error: `"withdraw" really withdraws the invitation on this LinkedIn account — pass confirm: true` });
  }
  if (action === "message" && !text?.trim()) return res.status(400).json({ error: "text is required for a message" });

  let page: Page | undefined;
  const reply = (outcome: Outcome) => res.json(outcome);
  // An invitation is out now. One that follows a withdrawal is a new request, so it takes
  // a new date and clears the withdrawal; otherwise the first date recorded stands.
  const recordInvitation = () => {
    if (!contactId) return;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE targets SET connection_requested_at = CASE WHEN invite_withdrawn_at IS NULL THEN COALESCE(connection_requested_at, ?) ELSE ? END,
              invite_withdrawn_at = NULL WHERE id = ?`
    ).run(now, now, contactId);
  };
  try {
    page = await getSessionPage(accountId);

    if (action === "inspect") {
      // The same reading the connect step does, More menu included — and nothing else.
      await gotoLinkedin(page, canonicalLinkedinUrl(profileUrl));
      const { card, relation, inviteHref, via } = await readRelation(page);
      return reply({
        ok: true, action, outcome: relation,
        detail: { url: canonicalLinkedinUrl(profileUrl), name: card.name, degree: card.degree, relation, found_via: via, can_invite: !!inviteHref, invite_blocked: card.inviteBlocked, can_message: relation === "connected" && !!card.messageHref },
      });
    }

    if (action === "visit") {
      await visitProfile(page, profileUrl);
      return reply({ ok: true, action, outcome: "visited" });
    }

    if (action === "connect") {
      const result = await sendConnectionRequest(page, profileUrl, { note });
      recordInvitation();
      recordAudit(ctx, "account.test_connect", "account", accountId, { url: canonicalLinkedinUrl(profileUrl), contact_id: contactId, note_sent: result.noteSent });
      return reply({ ok: true, action, outcome: "invitation_pending", detail: result });
    }

    if (action === "withdraw") {
      await withdrawInvitation(page, profileUrl);
      if (contactId) db.prepare("UPDATE targets SET invite_withdrawn_at = ? WHERE id = ?").run(new Date().toISOString(), contactId);
      // Counts towards the account's daily withdrawal limit like any other.
      recordWithdrawal(db, { accountId, targetId: contactId, source: "manual", outcome: "withdrawn" });
      recordAudit(ctx, "account.test_withdraw", "account", accountId, { url: canonicalLinkedinUrl(profileUrl), contact_id: contactId });
      return reply({ ok: true, action, outcome: "invitation_withdrawn" });
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
      recordInvitation();
      return reply({ ok: false, action, outcome: "invitation_already_pending" });
    }
    if (err instanceof NoPendingInviteError) {
      // LinkedIn shows it as withdrawn already: worth knowing on the contact all the same.
      if (err.alreadyWithdrawn && contactId) db.prepare("UPDATE targets SET invite_withdrawn_at = COALESCE(invite_withdrawn_at, ?) WHERE id = ?").run(new Date().toISOString(), contactId);
      return reply({ ok: false, action, outcome: err.alreadyWithdrawn ? "invitation_already_withdrawn" : "no_pending_invitation" });
    }
    if (err instanceof InviteBlockedError) return reply({ ok: false, action, outcome: "invitation_blocked", detail: message });
    if (err instanceof WithdrawUnconfirmedError) {
      // In the ledger, so campaigns and the clean-up stop withdrawing for the day as well.
      recordWithdrawal(db, { accountId, targetId: contactId, source: "manual", outcome: "unconfirmed", detail: message });
      return reply({ ok: false, action, outcome: "withdrawal_unconfirmed", detail: message });
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
