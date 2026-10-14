// What a campaign does about spam wording in its emails.
//
//   off     nothing is checked.
//   flag    each email is scanned and what is found is shown (in the editor, the preview and
//           the run log). It is sent as written.
//   remove  each email is scanned, then cleaned just before it is sent: pressure phrases come
//           out, capitals are lowered, "!!!" becomes "!". What cannot be mended is left, and
//           flagged.
//
// A campaign can name its own mode; with none it follows the workspace's default, and a
// workspace that has chosen nothing flags.
import type DatabaseType from "better-sqlite3";
import {
  FALLBACK_SPAM_MODE, SPAM_MODES, SPAM_MODE_HINT, SPAM_MODE_LABEL, checkSpam, cleanSpam, describeFindings, isSpamMode,
  type SpamClean, type SpamField, type SpamMode, type SpamReport,
} from "@/lib/email/spam-check";
import { getWorkspaceSetting, setWorkspaceSetting } from "@/lib/workspace-settings";

type DB = DatabaseType.Database;

export { SPAM_MODES, FALLBACK_SPAM_MODE, SPAM_MODE_LABEL, SPAM_MODE_HINT, isSpamMode, type SpamMode };

const KEY = "spam_filter_default";

export function workspaceSpamDefault(db: DB, workspaceId: string): SpamMode {
  const stored = getWorkspaceSetting(workspaceId, KEY, db);
  return isSpamMode(stored) ? stored : FALLBACK_SPAM_MODE;
}

export function setWorkspaceSpamDefault(db: DB, workspaceId: string, mode: SpamMode): void {
  setWorkspaceSetting(workspaceId, KEY, mode, db);
}

/** The campaign's own choice, or null when it follows the workspace. */
export function campaignSpamChoice(db: DB, workflowId: string): SpamMode | null {
  const stored = (db.prepare("SELECT spam_filter FROM workflows WHERE id = ?").get(workflowId) as { spam_filter: string | null } | undefined)?.spam_filter;
  return isSpamMode(stored) ? stored : null;
}

/** The mode a campaign's emails are held to now. */
export function spamModeOf(db: DB, workspaceId: string, workflowId: string | null): SpamMode {
  return (workflowId ? campaignSpamChoice(db, workflowId) : null) ?? workspaceSpamDefault(db, workspaceId);
}

/** Why this cannot be a campaign's spam filter setting, or null. null itself means "follow the workspace". */
export function spamChoiceProblem(value: unknown): string | null {
  if (value === null || value === "inherit" || isSpamMode(value)) return null;
  return "spam_filter must be off, flag, remove or inherit";
}

export function saveSpamChoice(db: DB, workflowId: string, value: unknown): void {
  db.prepare("UPDATE workflows SET spam_filter = ? WHERE id = ?").run(isSpamMode(value) ? value : null, workflowId);
}

export interface SpamOutcome {
  mode: SpamMode;
  /** Subject and body to go out: cleaned in remove mode, otherwise as given. */
  subject: string;
  body: string;
  /** What was found in the text as written. Null when the filter is off. */
  report: SpamReport | null;
  /** What was taken out and what could not be: only in remove mode. */
  clean: SpamClean | null;
}

/** Apply a mode to one email's text. */
export function applySpamFilter(mode: SpamMode, text: { subject: string; body: string }): SpamOutcome {
  if (mode === "off") return { mode, ...text, report: null, clean: null };
  const report = checkSpam(text);
  if (mode === "flag" || report.findings.length === 0) return { mode, ...text, report, clean: null };
  const clean = cleanSpam(text);
  return { mode, subject: clean.subject, body: clean.body, report, clean };
}

/** One line for the run log: what the filter found and did. Null when there is nothing to say. */
export function spamLogLine(outcome: SpamOutcome, who: string): string | null {
  const { report, clean } = outcome;
  if (!report || report.findings.length === 0) return null;
  const where = (field: SpamField) => (field === "subject" ? "subject" : "body");
  if (clean && clean.removed.length > 0) {
    const removed = clean.removed.map((entry) => `${where(entry.field)}: "${entry.text.trim()}"${entry.replacement ? ` → "${entry.replacement}"` : ""}`).join("; ");
    const left = clean.left.length > 0 ? ` Left for someone to rewrite: ${describeFindings(clean.left)}.` : "";
    return `Spam filter cleaned the email to ${who} (${removed}).${left}`;
  }
  return `Spam filter flagged the email to ${who}: ${describeFindings(report.findings, 5)} (${report.level}, score ${report.score}).`;
}
