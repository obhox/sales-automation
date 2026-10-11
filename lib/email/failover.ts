import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { getWorkspaceSwitch } from "@/lib/workspace-settings";

// What happens to a mailbox's contacts when its guard pauses it.
//
// As it has always been, they wait: a paused mailbox holds every contact where they are.
// A workspace can instead have the contacts who have not been emailed yet carried on by
// the campaign's other mailboxes. Only those contacts: someone who has had an email from
// this mailbox gets the follow-ups from it too, or they would arrive from a stranger
// outside the conversation. So would their colleagues, who are kept with the same mailbox
// as the rest of their company.

type DB = DatabaseType.Database;

export interface FailoverResult {
  /** Contacts now with another mailbox. */
  moved: number;
  /** Contacts left waiting for this mailbox: already emailed from it, or nowhere else to go. */
  waiting: number;
}

interface Candidate {
  profile_id: string;
  run_id: string;
  target_id: string;
  company_id: string | null;
  emailed: number;
}

/**
 * Move a paused mailbox's not-yet-emailed contacts to the other mailboxes of their
 * campaigns. Does nothing unless the workspace has switched this on.
 */
export function moveWaitingContacts(db: DB, emailAccountId: string): FailoverResult {
  const mailbox = db.prepare("SELECT workspace_id, from_email FROM email_accounts WHERE id = ?").get(emailAccountId) as { workspace_id: string; from_email: string } | undefined;
  if (!mailbox || !getWorkspaceSwitch(mailbox.workspace_id, "mailbox_failover", db)) return { moved: 0, waiting: 0 };

  // Everyone still to be emailed from this mailbox in a live campaign. `emailed` covers an
  // email that went, one that may have gone, and one on its way out right now.
  const candidates = db.prepare(`
    SELECT rp.id AS profile_id, rp.run_id, rp.target_id, t.company_id,
      EXISTS (SELECT 1 FROM email_jobs j WHERE j.run_id = rp.run_id AND j.target_id = rp.target_id AND j.source = 'campaign'
        AND j.status IN ('sent', 'uncertain', 'leased', 'sending')) AS emailed
    FROM run_profiles rp
    JOIN runs r ON r.id = rp.run_id
    JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id AND rt.track = 'email'
    LEFT JOIN targets t ON t.id = rp.target_id
    WHERE rp.email_account_id = ? AND r.status IN ('running', 'paused') AND rt.state IN ('pending', 'in_progress')
    ORDER BY rp.run_id, rp.rowid`).all(emailAccountId) as Candidate[];
  if (candidates.length === 0) return { moved: 0, waiting: 0 };

  const waitingOn = db.prepare(`SELECT COUNT(*) AS c FROM run_profiles rp JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id AND rt.track = 'email'
    WHERE rp.run_id = ? AND rp.email_account_id = ? AND rt.state IN ('pending', 'in_progress')`);
  const move = db.prepare("UPDATE run_profiles SET email_account_id = ? WHERE id = ?");
  // An email queued for the old mailbox and never sent would still go from it when it
  // resumes. It is dropped, so the step is written again for the new mailbox.
  const dropQueued = db.prepare("DELETE FROM email_jobs WHERE run_id = ? AND target_id = ? AND source = 'campaign' AND email_account_id = ? AND status = 'pending'");
  const log = db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'info', ?)");

  let moved = 0;
  db.transaction(() => {
    const byRun = new Map<string, Candidate[]>();
    for (const candidate of candidates) byRun.set(candidate.run_id, [...(byRun.get(candidate.run_id) ?? []), candidate]);

    for (const [runId, contacts] of byRun) {
      // The campaign's other mailboxes that can send right now.
      const others = db.prepare(`SELECT DISTINCT ea.id, ea.from_email FROM run_profiles rp JOIN email_accounts ea ON ea.id = rp.email_account_id
        WHERE rp.run_id = ? AND ea.id != ? AND ea.paused_at IS NULL AND ea.disconnected_at IS NULL AND ea.is_verified = 1`).all(runId, emailAccountId) as Array<{ id: string; from_email: string }>;
      if (others.length === 0) continue;
      const load = new Map(others.map((other) => [other.id, (waitingOn.get(runId, other.id) as { c: number }).c]));
      const lightest = () => others.reduce((best, other) => (load.get(other.id)! < load.get(best.id)! ? other : best));

      // A company with anyone already emailed from this mailbox stays with it, whole.
      const keptCompanies = new Set(contacts.filter((contact) => contact.emailed && contact.company_id).map((contact) => contact.company_id!));
      const companyMailbox = new Map<string, { id: string; from_email: string }>();
      for (const contact of contacts) {
        if (contact.emailed || (contact.company_id && keptCompanies.has(contact.company_id))) continue;
        let to = contact.company_id ? companyMailbox.get(contact.company_id) : undefined;
        if (!to) {
          to = lightest();
          if (contact.company_id) companyMailbox.set(contact.company_id, to);
        }
        move.run(to.id, contact.profile_id);
        dropQueued.run(runId, contact.target_id, emailAccountId);
        load.set(to.id, load.get(to.id)! + 1);
        log.run(randomUUID(), runId, contact.target_id, `Moved to ${to.from_email}: ${mailbox.from_email} was paused before this contact had been emailed`);
        moved++;
      }
    }
  })();
  return { moved, waiting: candidates.length - moved };
}
