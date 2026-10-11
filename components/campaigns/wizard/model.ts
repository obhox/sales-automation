// The campaign wizard's own words and rules. No React.
import type { AiContext } from "@/lib/campaigns/context";
import type { CampaignSetup, Check, Prelaunch, SetupOptions, SetupStep } from "@/lib/campaigns/setup";
import { formatCount, plural } from "@/lib/client/format";
import type { BuilderData, StepInput } from "@/components/sequence/model";

export type { AiContext, CampaignSetup, Check, Prelaunch, SetupOptions, SetupStep };

export const STEPS: Array<{ key: SetupStep; name: string; back: string; title: string; hint: string }> = [
  { key: "list", name: "List picker", back: "the list picker", title: "Who is it for", hint: "Name the campaign and choose the list to run it on." },
  { key: "context", name: "AI context", back: "AI context", title: "Brief the AI writer", hint: "What the campaign is about. Used by every step that AI writes, and by AI rewrite." },
  { key: "linkedin", name: "LinkedIn steps", back: "LinkedIn steps", title: "LinkedIn steps", hint: "Visits, connection requests and messages. Leave it empty for an email-only campaign." },
  { key: "email", name: "Email steps", back: "email steps", title: "Email steps", hint: "Emails, beside the LinkedIn steps or taking over from them. Leave it empty for a LinkedIn-only campaign." },
  { key: "senders", name: "Sender accounts", back: "sender accounts", title: "Who it is sent from", hint: "The LinkedIn accounts and mailboxes this campaign runs from." },
  { key: "summary", name: "Summary", back: "the summary", title: "Review and launch", hint: "Everything below can still be changed until you launch." },
];
export const stepIndex = (key: SetupStep) => STEPS.findIndex((step) => step.key === key);

export interface SetupData {
  campaign: { id: string; name: string; description: string | null; prompt: string | null; send_in_recipient_tz: boolean; status: string; enrolled: number; run: { id: string; status: string } | null };
  setup: CampaignSetup;
  ai: AiContext;
  ai_available: boolean;
  default_model: string | null;
  options: SetupOptions;
}

/** What the wizard holds while it is open. Saved as it changes once the campaign exists. */
export interface Draft {
  name: string;
  prompt: string;
  setup: CampaignSetup;
  ai: AiContext;
}

export const EMPTY_DRAFT: Draft = {
  name: "", prompt: "",
  setup: { step: "list", list_id: null, exclude: { customers: true, open_deals: true }, account_ids: [], rotation: "round_robin", email_account_ids: [], overlap: "skip" },
  ai: { angle: "", tone: "", triggers: [], model: null },
};

export const draftFrom = (data: SetupData): Draft => ({ name: data.campaign.name, prompt: data.campaign.prompt ?? "", setup: data.setup, ai: data.ai });

export const TONE_IDEAS = ["Direct, peer-to-peer", "Warm and conversational", "Brief and plain", "Formal"];

/** What a sequence holds, as the rail and the review cards say it. */
export interface SequenceFacts {
  linkedin: Array<{ type: string; label: string; day: number }>;
  email: Array<{ type: string; label: string; day: number }>;
  versions: number;
  aiSteps: number;
}

const DAY = 86_400;
const SHORT: Record<string, string> = { visit: "Profile visit", connect: "Connection request", message: "LinkedIn message", sales_inmail: "InMail", email: "Email" };

export function sequenceFacts(steps: StepInput[]): SequenceFacts {
  const facts: SequenceFacts = { linkedin: [], email: [], versions: 0, aiSteps: 0 };
  const elapsed = { linkedin: 0, email: 0 };
  const seen: Record<string, number> = {};
  for (const step of steps) {
    const track = step.track === "email" || step.step_type === "email" ? "email" : "linkedin";
    if (step.step_type === "delay") { elapsed[track] += Math.max(0, Number(step.delay_seconds) || 0); continue; }
    seen[step.step_type] = (seen[step.step_type] ?? 0) + 1;
    const extra = (step.email_variants ?? []).length;
    if (step.step_type === "email" && extra > 0) facts.versions += extra + 1;
    if (step.ai_enabled === true || step.ai_enabled === 1) facts.aiSteps += 1;
    const label = step.step_type === "connect" && step.connect_note?.trim() ? "Connection request + note"
      : step.step_type === "message" && seen.message > 1 ? "Follow-up message"
      : step.step_type === "email" ? `Email ${seen.email}${extra > 0 ? ` · ${extra + 1} A/B versions` : ""}`
      : SHORT[step.step_type] ?? step.step_type;
    facts[track].push({ type: step.step_type, label, day: 1 + Math.floor(elapsed[track] / DAY) });
  }
  return facts;
}

const KIND_WORD: Record<string, [string, string]> = { visit: ["visit", "visits"], connect: ["invite", "invites"], message: ["message", "messages"], sales_inmail: ["InMail", "InMails"] };

/** The line under each step's name in the rail. */
export function railLine(key: SetupStep, draft: Draft, options: SetupOptions | undefined, facts: SequenceFacts | null): string {
  switch (key) {
    case "list": {
      const list = options?.lists.find((candidate) => candidate.id === draft.setup.list_id);
      return list ? `${list.name} · ${formatCount(list.contacts)}` : "Choose who to reach";
    }
    case "context": {
      const parts = [draft.prompt.trim() ? "Value prop" : "", draft.ai.angle ? "angle" : "", draft.ai.tone ? "tone" : "", draft.ai.triggers.length ? `${draft.ai.triggers.length} trigger ${plural(draft.ai.triggers.length, "source", "sources")}` : ""].filter(Boolean);
      return parts.length ? parts.join(", ").replace(/^./, (first) => first.toUpperCase()) : "Optional: brief the AI writer";
    }
    case "linkedin": {
      if (!facts) return "…";
      if (facts.linkedin.length === 0) return "No LinkedIn steps";
      const counts = new Map<string, number>();
      for (const step of facts.linkedin) counts.set(step.type, (counts.get(step.type) ?? 0) + 1);
      const kinds = [...counts.entries()].map(([type, n]) => (n === 1 ? KIND_WORD[type]?.[0] ?? type : `${n} ${KIND_WORD[type]?.[1] ?? type}`));
      return `${facts.linkedin.length} ${plural(facts.linkedin.length, "step", "steps")} · ${kinds.join(", ")}`;
    }
    case "email": {
      if (!facts) return "…";
      if (facts.email.length === 0) return "No email steps";
      return `${facts.email.length} ${plural(facts.email.length, "step", "steps")}${facts.versions > 0 ? ` · ${facts.versions} A/B versions` : ""}`;
    }
    case "senders": {
      const li = draft.setup.account_ids.length;
      const mail = draft.setup.email_account_ids.length;
      return li + mail === 0 ? "Choose who it is sent from" : `${li} LinkedIn · ${mail} ${plural(mail, "mailbox", "mailboxes")}`;
    }
    case "summary":
      return "Review conflicts and launch";
  }
}

/** Whether a step has what it needs. `null` means there is nothing it must have. */
export function stepDone(key: SetupStep, draft: Draft, facts: SequenceFacts | null, prelaunch: Prelaunch | undefined): boolean | null {
  switch (key) {
    case "list": return Boolean(draft.name.trim() && draft.setup.list_id);
    case "context": return draft.prompt.trim() || draft.ai.angle || draft.ai.tone || draft.ai.triggers.length ? true : null;
    case "linkedin": return facts ? (facts.linkedin.length > 0 ? true : facts.email.length > 0 ? null : false) : null;
    case "email": return facts ? (facts.email.length > 0 ? true : facts.linkedin.length > 0 ? null : false) : null;
    case "senders": {
      if (!facts) return null;
      const needsLinkedin = facts.linkedin.length > 0;
      const needsEmail = facts.email.length > 0;
      return (!needsLinkedin || draft.setup.account_ids.length > 0) && (!needsEmail || draft.setup.email_account_ids.length > 0) && (needsLinkedin || needsEmail);
    }
    case "summary": return prelaunch ? prelaunch.ready : null;
  }
}

/** Why the wizard cannot move on from a step, or null. Only the first step holds anyone up: the rest can be come back to. */
export function nextProblem(key: SetupStep, draft: Draft): string | null {
  if (key !== "list") return null;
  if (!draft.name.trim()) return "Give the campaign a name";
  if (!draft.setup.list_id) return "Choose the list to run it on";
  return null;
}

export const clearChecks = (checks: Check[]) => checks.filter((check) => check.state === "ok").length;

/** The box at the foot of the rail: the state of the senders, in a sentence. */
export function safetyNote(prelaunch: Prelaunch | undefined): { ok: boolean; title: string; body: string } | null {
  if (!prelaunch) return null;
  const senders = prelaunch.checks.filter((check) => check.key === "linkedin" || check.key === "mailboxes");
  const worst = senders.find((check) => check.state === "block") ?? senders.find((check) => check.state === "warn");
  const total = prelaunch.capacity.linkedin_accounts + prelaunch.capacity.mailboxes;
  if (total === 0 && !worst) return null;
  if (worst) return { ok: false, title: worst.state === "block" ? "A sender needs attention" : "Worth a look before launch", body: worst.detail };
  return { ok: true, title: "Safe sending checks passed", body: `${total === 1 ? "The sender account is" : `All ${total} sender accounts are`} signed in, verified and under ${total === 1 ? "its" : "their"} daily caps.` };
}

/** "Jordan, Priya and 1 more", for the review card. */
export function nameList(names: string[], max = 2): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export const usd = (amount: number | null | undefined, digits = 2) => (amount == null ? "—" : `$${amount.toFixed(amount < 0.1 && amount > 0 ? Math.max(digits, 3) : digits)}`);
export const tokens = (n: number | null | undefined) => (n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export type { BuilderData };
