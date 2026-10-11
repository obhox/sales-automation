import { getDb } from "@/lib/db";
import { domainOf } from "@/lib/email/dns";
import { recordGuardEvent } from "@/lib/email/guard-events";
import { recordProviderEvent } from "@/lib/email/infrastructure";

// Spam complaints that arrive as mail.
//
// Some mailbox providers tell a sender when a recipient presses "report spam" by sending a
// feedback report (RFC 5965) to an address the sender registered with them. Where that
// address is a mailbox Linki reads, the report is a complaint Linki can count. Most
// providers, Gmail among them, send no such mail to ordinary senders, so a count of zero
// means "none reported", never "none happened".

export interface FeedbackReport {
  /** abuse (a spam complaint), or what else the provider called it. */
  type: string;
  /** The address that complained, when the report names it. */
  recipient: string | null;
  /** The Message-ID of the email complained about, when the report quotes it. */
  messageId: string | null;
}

const first = (text: string, pattern: RegExp) => pattern.exec(text)?.[1]?.trim() ?? null;

/**
 * Read a feedback report out of a message's text. Null for anything that is not one. The
 * text is the message body as stored on the server: the report's own fields, then the
 * headers of the email complained about.
 */
export function parseFeedbackReport(body: string): FeedbackReport | null {
  const type = first(body, /^Feedback-Type:\s*([a-z-]+)/im);
  if (!type) return null;
  const recipient = first(body, /^Original-Rcpt-To:\s*<?([^\s<>]+@[^\s<>]+)>?/im) ?? first(body, /^Removal-Recipient:\s*<?([^\s<>]+@[^\s<>]+)>?/im);
  // The quoted email's own Message-ID comes after the report's fields. A report has one
  // of its own in its headers, which are not part of this text.
  const afterReport = body.slice(body.search(/^Feedback-Type:/im));
  const messageId = first(afterReport, /^Message-ID:\s*(<[^>\s]+>)/im);
  return { type: type.toLowerCase(), recipient: recipient?.toLowerCase() ?? null, messageId };
}

/**
 * What the reply reader calls for each recent message it has in hand. If the message is a
 * spam complaint about an email this workspace sent, it is recorded as one: counted
 * against the mailbox that sent it, the address added to the do-not-contact list, and the
 * mailbox's guard looked at again. Returns whether a complaint was recorded.
 */
export function noteFeedbackReport(input: { workspaceId: string; reportMessageId: string; body: string }): boolean {
  try {
    const report = parseFeedbackReport(input.body);
    // Only complaints. A provider's "not-spam" or "opt-out" report is a different fact.
    if (!report || !["abuse", "fraud", "virus"].includes(report.type)) return false;
    if (!report.recipient && !report.messageId) return false;
    const result = recordProviderEvent({
      workspaceId: input.workspaceId, provider: "feedback-report", providerEventId: input.reportMessageId, eventType: "complained",
      recipient: report.recipient ?? undefined, messageId: report.messageId ?? undefined, payload: { feedback_type: report.type },
    });
    if (!result.matched || result.duplicate) return false;
    const sender = getDb().prepare(`SELECT se.email_account_id AS id, se.recipient, ea.from_email FROM sender_events se JOIN email_accounts ea ON ea.id = se.email_account_id
      WHERE se.provider = 'feedback-report' AND se.provider_event_id = ?`).get(input.reportMessageId) as { id: string; recipient: string | null; from_email: string } | undefined;
    if (sender) {
      recordGuardEvent({
        workspaceId: input.workspaceId, kind: "complaint", tone: "warn", emailAccountId: sender.id, domain: domainOf(sender.from_email),
        title: `An email from ${sender.from_email} was marked as spam`,
        detail: `${sender.recipient ?? "The recipient"} reported it, and their mail provider told this mailbox. The address is now on the do-not-contact list.`,
        dedupeKey: `complaint:${input.reportMessageId}`,
      });
    }
    return true;
  } catch (error) {
    // Counting complaints must never get in the way of reading mail.
    console.warn("[feedback-report] could not record a report:", error instanceof Error ? error.message : error);
    return false;
  }
}
