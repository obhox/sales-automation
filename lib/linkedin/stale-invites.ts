import type DatabaseType from "better-sqlite3";
import type { Page } from "playwright";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import { AlreadyConnectedError } from "@/lib/linkedin/connect";
import { withdrawInvitation, NoPendingInviteError, WithdrawUnconfirmedError } from "@/lib/linkedin/withdraw";
import { recordWithdrawal, type StaleInvite, type WithdrawalOutcome } from "@/lib/linkedin/withdrawals";
import { emitDomainEvent } from "@/lib/platform/events";

type DB = DatabaseType.Database;

/**
 * Withdraw one stale invitation and record what LinkedIn showed.
 *
 * `signed_out` means the account's session is gone: it has been flagged for
 * re-authentication, nothing is recorded against the contact, and the caller should stop
 * working this account. Every other result is final for this visit and is written to
 * `linkedin_withdrawals`, so the contact is not picked again unless the visit settled
 * nothing (`failed`, `unconfirmed`). After `unconfirmed` the caller should stop too.
 */
export async function withdrawStaleInvite(db: DB, accountId: string, contact: StaleInvite): Promise<WithdrawalOutcome | "signed_out"> {
  const record = (outcome: WithdrawalOutcome, detail?: string) =>
    recordWithdrawal(db, { accountId, targetId: contact.id, source: "cleanup", outcome, detail });
  const stampWithdrawn = () =>
    db.prepare("UPDATE targets SET invite_withdrawn_at = ? WHERE id = ?").run(new Date().toISOString(), contact.id);

  let page: Page | null = null;
  let outcome: WithdrawalOutcome | "signed_out";
  try {
    page = await getSessionPage(accountId);
    await withdrawInvitation(page, contact.linkedin_url);
    stampWithdrawn();
    record("withdrawn");
    outcome = "withdrawn";
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      await markNeedsReauth(accountId).catch(() => {});
      outcome = "signed_out";
    } else if (err instanceof AlreadyConnectedError) {
      // They accepted, and the connections sync has not caught up (it only runs while a
      // campaign does). LinkedIn's profile is the authority here, as it is for the runner.
      const target = db.prepare("SELECT workspace_id FROM targets WHERE id = ?").get(contact.id) as { workspace_id: string } | undefined;
      db.prepare("UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(new Date().toISOString(), contact.id);
      if (target) emitDomainEvent({ workspaceId: target.workspace_id, type: "linkedin.connected", entityType: "target", entityId: contact.id, payload: { account_id: accountId } });
      record("connected");
      outcome = "connected";
    } else if (err instanceof NoPendingInviteError) {
      if (err.alreadyWithdrawn) stampWithdrawn();
      outcome = err.alreadyWithdrawn ? "already_withdrawn" : "not_pending";
      record(outcome);
    } else {
      // `unconfirmed` also puts the account's withdrawals on hold for the day (withdrawalsOnHold).
      outcome = err instanceof WithdrawUnconfirmedError ? "unconfirmed" : "failed";
      record(outcome, err instanceof Error ? err.message.split("\n")[0] : String(err));
    }
  } finally {
    try { await page?.close(); } catch { /* already gone */ }
  }
  if (outcome !== "signed_out") await saveSessionState(accountId).catch(() => {});
  return outcome;
}
