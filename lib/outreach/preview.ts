// What a sequence says to one contact: every step in order, with the day it falls on and
// the words that contact would read. Nothing is sent and no AI is called; a step written
// by AI at send time says so instead of showing text.
import type DatabaseType from "better-sqlite3";
import { fillUnsubscribeTags, hasUnsubscribeTag, toPlainText, unsubscribeUrl } from "@/lib/email/content";
import { applySpamFilter, type SpamMode, type SpamOutcome } from "@/lib/campaigns/spam-filter";
import type { SpamFinding, SpamLevel, SpamRemoval } from "@/lib/email/spam-check";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import { trackOf, type SequenceDraft, type StepInput, type Track } from "@/lib/outreach/publish";
import { EMAIL_TAGS, lintTemplate, renderOutreachTemplate, senderOf, type OutreachSender, type OutreachTemplateTarget } from "@/lib/outreach/render";

type DB = DatabaseType.Database;

export interface PreviewContact extends OutreachTemplateTarget {
  id: string;
  email: string | null;
  linkedin_url: string | null;
}

export interface PreviewSenders {
  linkedin: { id: string; name: string } | null;
  email: { id: string; name: string; email: string; signature: string | null } | null;
}

/** What the spam filter made of one email, as the preview shows it. */
export interface SpamView {
  mode: SpamMode;
  level: SpamLevel;
  score: number;
  /** In the text as written. */
  findings: SpamFinding[];
  /** The text shown is the cleaned one: this is what was taken out, and what is left to rewrite. */
  removed: SpamRemoval[];
  left: SpamFinding[];
}

export function spamView(outcome: SpamOutcome): SpamView | null {
  if (!outcome.report) return null;
  return {
    mode: outcome.mode, level: outcome.report.level, score: outcome.report.score, findings: outcome.report.findings,
    removed: outcome.clean?.removed ?? [], left: outcome.clean?.left ?? [],
  };
}

export interface StepPreview {
  /** The step's id, or the key a step not yet published was given. */
  ref: string | null;
  track: Track;
  step_type: StepInput["step_type"];
  /** The day of the contact's time in this track that the step falls on, starting at 1. */
  day: number;
  /** `text`: the words are below. `ai`: written for each contact when it is sent. `none`: a step that sends no words. */
  content: "text" | "ai" | "none";
  subject: string | null;
  body: string | null;
  signature: string | null;
  /** Which of the step's versions or pooled templates is shown, and out of how many. */
  shown: { label: string; of: number } | null;
  warnings: string[];
  /** For an email, when the campaign's spam filter is on. In remove mode `subject` and `body` are already cleaned. */
  spam?: SpamView | null;
}

const SECONDS_IN_DAY = 86_400;
const letter = (index: number) => String.fromCharCode(65 + index);

export function previewContact(db: DB, workspaceId: string, targetId: string): PreviewContact | null {
  return (db.prepare("SELECT id, first_name, last_name, full_name, company, title, location, email, linkedin_url FROM targets WHERE id = ? AND workspace_id = ?")
    .get(targetId, workspaceId) as PreviewContact | undefined) ?? null;
}

/**
 * Who the preview is sent from: the mailbox and LinkedIn account asked for, or else the ones
 * the campaign's latest run uses. With neither, sender tags are shown as written.
 */
export function previewSenders(db: DB, workspaceId: string, workflowId: string | null, chosen: { emailAccountId?: string | null; accountId?: string | null } = {}): PreviewSenders {
  const run = workflowId
    ? db.prepare("SELECT id, account_id FROM runs WHERE workflow_id = ? AND workspace_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1").get(workflowId, workspaceId) as { id: string; account_id: string | null } | undefined
    : undefined;
  const mailboxId = chosen.emailAccountId
    ?? (run ? (db.prepare("SELECT email_account_id AS id FROM run_profiles WHERE run_id = ? AND email_account_id IS NOT NULL LIMIT 1").get(run.id) as { id: string } | undefined)?.id : undefined);
  const accountId = chosen.accountId ?? run?.account_id;
  const mailbox = mailboxId
    ? db.prepare("SELECT id, name, from_name, from_email, signature FROM email_accounts WHERE id = ? AND workspace_id = ?").get(mailboxId, workspaceId) as { id: string; name: string; from_name: string | null; from_email: string; signature: string | null } | undefined
    : undefined;
  const account = accountId ? db.prepare("SELECT id, name FROM accounts WHERE id = ? AND workspace_id = ?").get(accountId, workspaceId) as { id: string; name: string } | undefined : undefined;
  return {
    linkedin: account ?? null,
    email: mailbox ? { id: mailbox.id, name: mailbox.from_name || mailbox.name, email: mailbox.from_email, signature: mailbox.signature } : null,
  };
}

/** The templates of one channel among a step's pool, in the order the step lists them. */
function pool(db: DB, workspaceId: string, step: StepInput, channel: "linkedin" | "email"): Array<{ id: string; name: string; body: string; subject: string | null }> {
  const ids = [...(step.template_ids ?? []), ...(channel === "linkedin" && step.template_id && !(step.template_ids ?? []).length ? [step.template_id] : [])];
  const find = db.prepare("SELECT id, name, body, subject FROM templates WHERE id = ? AND workspace_id = ? AND channel = ?");
  return ids.map((id) => find.get(id, workspaceId, channel) as { id: string; name: string; body: string; subject: string | null } | undefined).filter((row): row is NonNullable<typeof row> => Boolean(row));
}

/**
 * One step as one contact would receive it. `pick` chooses among an email's versions
 * (0 is A) or among a pool's templates; without it the first is shown.
 */
export function previewStep(
  db: DB, workspaceId: string, contact: PreviewContact, step: StepInput, senders: PreviewSenders,
  options: { day?: number; pick?: number; custom?: Record<string, string>; spamMode?: SpamMode } = {},
): StepPreview {
  const track = trackOf(step);
  const custom = options.custom ?? loadTargetCustomValues(db, workspaceId, contact.id);
  const customKeys = Object.keys(custom);
  const seed = `preview:${contact.id}`;
  const base: StepPreview = { ref: step.id ?? step.key ?? null, track, step_type: step.step_type, day: options.day ?? 1, content: "none", subject: null, body: null, signature: null, shown: null, warnings: [] };
  const linkedinSender: OutreachSender | null = senders.linkedin ? { name: senders.linkedin.name, email: null } : null;
  const emailSender: OutreachSender | null = senders.email ? senderOf({ name: senders.email.name, email: senders.email.email }) : null;
  // With nobody chosen to send from, a sender tag is not a mistake: it just cannot be filled yet.
  const lint = (text: string, sender: OutreachSender | null, email = false) =>
    lintTemplate(text, customKeys, { email }).filter((warning) => sender !== null || !warning.includes("{{sender."));
  const unfilled = (text: string, sender: OutreachSender | null) => (sender === null && /\{\{\s*sender\./i.test(text) ? ["Choose who this is sent from to fill the sender's details."] : []);

  if (step.step_type === "visit" || step.step_type === "delay") return base;

  if (step.step_type === "connect") {
    const note = (step.connect_note ?? "").trim();
    if (!note) return base;
    return { ...base, content: "text", body: renderOutreachTemplate(note, contact, custom, { seed, sender: linkedinSender }), warnings: [...lint(note, linkedinSender), ...unfilled(note, linkedinSender)] };
  }

  if (step.ai_enabled) return { ...base, content: "ai" };

  if (step.step_type === "message" || step.step_type === "sales_inmail") {
    const templates = pool(db, workspaceId, step, "linkedin");
    const template = templates.length ? templates[Math.min(options.pick ?? 0, templates.length - 1)] : null;
    const source = template?.body ?? step.message_body ?? "";
    if (!source.trim()) return { ...base, warnings: ["This step has nothing to send yet."] };
    const subjectSource = step.step_type === "sales_inmail" ? step.email_subject ?? "" : "";
    return {
      ...base, content: "text",
      subject: step.step_type === "sales_inmail" ? renderOutreachTemplate(subjectSource, contact, custom, { seed: `${seed}:subject`, sender: linkedinSender }) : null,
      body: renderOutreachTemplate(source, contact, custom, { seed, sender: linkedinSender }),
      shown: template ? { label: template.name, of: templates.length } : null,
      warnings: [...lint(`${subjectSource}\n${source}`, linkedinSender), ...unfilled(`${subjectSource}\n${source}`, linkedinSender)],
    };
  }

  // An email: its pool of templates if it has one, else its own versions.
  const templates = pool(db, workspaceId, step, "email");
  const versions = [{ subject: step.email_subject ?? "", body: step.email_body ?? "" }, ...(step.email_variants ?? []).map((variant) => ({ subject: variant.subject ?? "", body: variant.body ?? "" }))];
  const pickIndex = Math.max(0, options.pick ?? 0);
  const template = templates.length ? templates[Math.min(pickIndex, templates.length - 1)] : null;
  const version = versions[Math.min(pickIndex, versions.length - 1)];
  const chosen = template ? { subject: template.subject?.trim() ? template.subject : step.email_subject ?? "", body: template.body } : version;
  if (!chosen.body.trim()) return { ...base, warnings: ["This step has nothing to send yet."] };
  const signature = (step.email_signature !== undefined && step.email_signature !== null ? step.email_signature : senders.email?.signature ?? "").trim();
  const removeLinks = step.email_delivery_mode !== "enhanced";
  // Shown as the recipient will read it, with a stand-in where the signed link will be.
  const asRead = (value: string) => fillUnsubscribeTags(toPlainText(value, removeLinks), "[unsubscribe link]");
  const warnings = [...lint(`${chosen.subject}\n${chosen.body}`, emailSender, true), ...unfilled(`${chosen.subject}\n${chosen.body}\n${signature}`, emailSender)];
  if (hasUnsubscribeTag(chosen.subject)) warnings.push("{{unsubscribe}} does nothing in a subject. Put it in the body.");
  if (hasUnsubscribeTag(`${chosen.body}\n${signature}`) && !unsubscribeUrl("00000000-0000-0000-0000-000000000000")) {
    warnings.push("{{unsubscribe}} needs the app's public address (EMAIL_TRACKING_BASE_URL). Until that is set, this email will not send.");
  }
  if (!contact.email) warnings.push("This contact has no email address, so the step would be skipped.");
  const spam = options.spamMode
    ? applySpamFilter(options.spamMode, {
      subject: renderOutreachTemplate(chosen.subject, contact, custom, { seed: `${seed}:subject`, sender: emailSender }),
      body: asRead(renderOutreachTemplate(chosen.body, contact, custom, { seed, keep: EMAIL_TAGS, sender: emailSender })),
    })
    : null;
  return {
    ...base, content: "text",
    subject: spam ? spam.subject : renderOutreachTemplate(chosen.subject, contact, custom, { seed: `${seed}:subject`, sender: emailSender }),
    body: spam ? spam.body : asRead(renderOutreachTemplate(chosen.body, contact, custom, { seed, keep: EMAIL_TAGS, sender: emailSender })),
    spam: spam ? spamView(spam) : null,
    signature: signature ? asRead(renderOutreachTemplate(signature, contact, custom, { seed: `${seed}:signature`, keep: EMAIL_TAGS, sender: emailSender })) : null,
    shown: template ? { label: template.name, of: templates.length } : versions.length > 1 ? { label: `Version ${letter(Math.min(pickIndex, versions.length - 1))}`, of: versions.length } : null,
    warnings,
  };
}

/**
 * A step AI writes, shown as the words AI wrote for this contact. The text is the writer's
 * own, so no merge tags are filled in it; it is read the way the recipient will read it:
 * markup removed, the signature below it, and a stand-in where the unsubscribe link goes.
 */
export function previewWritten(
  contact: PreviewContact, step: StepInput, senders: PreviewSenders, written: { subject?: string | null; body: string },
  options: { day?: number; spamMode?: SpamMode } = {},
): StepPreview {
  const base: StepPreview = {
    ref: step.id ?? step.key ?? null, track: trackOf(step), step_type: step.step_type, day: options.day ?? 1,
    content: "text", subject: null, body: written.body.trim(), signature: null, shown: null, warnings: [],
  };
  if (step.step_type !== "email") return { ...base, subject: step.step_type === "sales_inmail" ? written.subject ?? "" : null };

  const signature = (step.email_signature !== undefined && step.email_signature !== null ? step.email_signature : senders.email?.signature ?? "").trim();
  const asRead = (value: string) => fillUnsubscribeTags(toPlainText(value, step.email_delivery_mode !== "enhanced"), "[unsubscribe link]");
  const emailSender = senders.email ? senderOf({ name: senders.email.name, email: senders.email.email }) : null;
  const warnings: string[] = [];
  if (!contact.email) warnings.push("This contact has no email address, so the step would be skipped.");
  const spam = options.spamMode ? applySpamFilter(options.spamMode, { subject: (written.subject ?? "").trim(), body: asRead(base.body ?? "") }) : null;
  return {
    ...base,
    subject: spam ? spam.subject : (written.subject ?? "").trim(),
    body: spam ? spam.body : asRead(base.body ?? ""),
    spam: spam ? spamView(spam) : null,
    // A signature can carry merge tags (the sender's name), which are filled as in a written email.
    signature: signature ? asRead(renderOutreachTemplate(signature, contact, {}, { seed: `preview:${contact.id}:signature`, keep: EMAIL_TAGS, sender: emailSender })) : null,
    warnings,
  };
}

/** The day each step of a track falls on, counting the waits before it. Day 1 is the day the track starts. */
export function stepDays(steps: readonly StepInput[]): Map<StepInput, number> {
  const elapsed: Record<Track, number> = { linkedin: 0, email: 0 };
  const days = new Map<StepInput, number>();
  for (const step of steps) {
    const track = trackOf(step);
    if (step.step_type === "delay") elapsed[track] += Math.max(0, Number(step.delay_seconds) || 0);
    else days.set(step, 1 + Math.floor(elapsed[track] / SECONDS_IN_DAY));
  }
  return days;
}

/** Every sending step of a sequence, LinkedIn track first, as one contact would get it. `pick` chooses among each step's versions, as in previewStep. */
export function previewSequence(db: DB, workspaceId: string, contact: PreviewContact, draft: Pick<SequenceDraft, "steps">, senders: PreviewSenders, options: { pick?: number; spamMode?: SpamMode } = {}): StepPreview[] {
  const custom = loadTargetCustomValues(db, workspaceId, contact.id);
  const days = stepDays(draft.steps);
  const ordered = [...draft.steps.filter((step) => trackOf(step) === "linkedin"), ...draft.steps.filter((step) => trackOf(step) === "email")];
  return ordered.filter((step) => step.step_type !== "delay").map((step) => previewStep(db, workspaceId, contact, step, senders, { day: days.get(step), custom, pick: options.pick, spamMode: options.spamMode }));
}
