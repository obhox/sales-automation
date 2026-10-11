// The sequence as its builder holds it, and everything the builder says about it. No React.
//
// The engine stores a track as a flat run of rows: sending steps, with a "delay" row
// wherever there is a wait. The builder keeps exactly that shape (so nothing an API caller
// built is lost by opening it here) and gives every row a `ref`: its id once published, or
// a key until then. Gates name the row they sit on by that ref.
import type { BuilderData, StepFigures, VersionFigures } from "@/lib/campaigns/builder";
import type { Effect, GateInput, GateKind, Outcome, OutcomeAction, SequenceDraft, SequenceSettings, StepInput, Track, VariantInput } from "@/lib/outreach/publish";
import { lintTemplate } from "@/lib/outreach/render";
import type { ConditionGroup, WorkflowCondition } from "@/lib/platform/conditions";
import { formatCount, formatPercent, plural, rate } from "@/lib/client/format";

export type { BuilderData, ConditionGroup, Effect, GateKind, Outcome, OutcomeAction, SequenceDraft, SequenceSettings, StepFigures, StepInput, Track, VariantInput, VersionFigures, WorkflowCondition };

export type SendType = "visit" | "connect" | "message" | "sales_inmail" | "email";
export interface Row extends StepInput { ref: string }
export interface Gate { source: string; kind: GateKind; conditions?: ConditionGroup; on_true: Outcome; on_false: Outcome }
export interface Doc { linkedin: Row[]; email: Row[]; gates: Gate[]; settings: SequenceSettings }

export const TRACKS: Track[] = ["linkedin", "email"];
export const TRACK_LABEL: Record<Track, string> = { linkedin: "LinkedIn track", email: "Email track" };
export const HOUR = 3600;
export const DAY = 86_400;
/** The step's own text is version A; up to three more can run beside it. */
export const MAX_VERSIONS = 4;
export const CONNECT_NOTE_LIMIT = 300;
export const letter = (index: number) => String.fromCharCode(65 + index);

const DEFAULT_SETTINGS: SequenceSettings = { email_start: "enrolment", linkedin_track_enabled: true, email_track_enabled: true };
/** What each kind of gate does on each side when nothing is chosen. Mirrors the engine's DEFAULT_OUTCOME. */
export const DEFAULT_OUTCOME: Record<GateKind, { true: OutcomeAction; false: OutcomeAction }> = {
  conditions: { true: "continue", false: "continue" },
  connected: { true: "continue", false: "end_track" },
  no_reply: { true: "continue", false: "leave" },
  verified_email: { true: "continue", false: "end_track" },
};

let counter = 0;
/** A key for a row that has no id yet. Unique within this browser tab, which is all a draft needs. */
export const newRef = () => `new-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const trackOf = (step: Pick<StepInput, "track" | "step_type">): Track => (step.track === "email" || step.step_type === "email" ? "email" : "linkedin");
const isOn = (value: unknown) => value === true || value === 1;

// ── Loading and saving ────────────────────────────────────────────────────────

/** Open a sequence (published, or a stored draft) for editing. */
export function docFrom(draft: Pick<SequenceDraft, "steps" | "gates" | "settings">): Doc {
  const doc: Doc = { linkedin: [], email: [], gates: [], settings: { ...DEFAULT_SETTINGS, ...(draft.settings ?? {}) } };
  for (const step of draft.steps) {
    const ref = (typeof step.id === "string" && step.id) || (typeof step.key === "string" && step.key) || newRef();
    doc[trackOf(step)].push({ ...step, track: trackOf(step), ref, email_variants: (step.email_variants ?? []).map((variant) => ({ ...variant })), template_ids: [...(step.template_ids ?? [])] });
  }
  const refs = new Set(rowsOf(doc).map((row) => row.ref));
  for (const gate of draft.gates ?? []) {
    if (!refs.has(gate.source)) continue;
    const kind = gate.kind ?? "conditions";
    doc.gates.push({
      source: gate.source, kind, ...(kind === "conditions" ? { conditions: gate.conditions ?? { mode: "all", conditions: [] } } : {}),
      on_true: gate.on_true ?? { then: DEFAULT_OUTCOME[kind].true }, on_false: gate.on_false ?? { then: DEFAULT_OUTCOME[kind].false },
    });
  }
  return doc;
}

export const rowsOf = (doc: Doc): Row[] => [...doc.linkedin, ...doc.email];
export const findRow = (doc: Doc, ref: string | null): Row | null => (ref ? rowsOf(doc).find((row) => row.ref === ref) ?? null : null);
export const gateOn = (doc: Doc, ref: string): Gate | null => doc.gates.find((gate) => gate.source === ref) ?? null;
export const isSending = (row: Pick<StepInput, "step_type">): boolean => row.step_type !== "delay";

/** The sequence as the engine takes it: LinkedIn rows then email rows, positions counted, new rows named by key. */
export function draftOf(doc: Doc): Required<SequenceDraft> {
  const position = { email: 0, message: 0 };
  const steps = rowsOf(doc).map((row): StepInput => {
    const { ref, ...step } = row;
    const published = typeof step.id === "string" && step.id === ref;
    const out: StepInput = { ...step, id: published ? step.id : null, key: published ? null : ref, track: trackOf(step) };
    if (step.step_type === "email") out.email_position = ++position.email;
    if (step.step_type === "message" || step.step_type === "sales_inmail") out.message_position = ++position.message;
    // The first email has nothing to be a reply to.
    if (step.step_type === "email" && position.email === 1) out.email_in_thread = 0;
    return out;
  });
  const refs = new Set(rowsOf(doc).map((row) => row.ref));
  const gates = doc.gates.filter((gate) => refs.has(gate.source)).map((gate): GateInput => ({
    source: gate.source, kind: gate.kind, ...(gate.kind === "conditions" ? { conditions: gate.conditions } : {}), on_true: gate.on_true, on_false: gate.on_false,
  }));
  return { steps, gates, settings: doc.settings };
}

const STEP_FIELDS = [
  "step_type", "delay_seconds", "connect_note", "message_body", "email_subject", "email_body", "email_signature", "email_delivery_mode", "email_track_opens",
  "email_track_clicks", "email_in_thread", "email_control_weight", "ai_enabled", "ai_model", "ai_prompt", "ai_max_words", "ai_language", "window_start", "window_end", "window_days",
] as const;
// Midnight is hour 0, so for a window's hours nought is a value, not an absence.
const ZERO_MEANS_ZERO = new Set<string>(["window_start", "window_end"]);
const blank = (value: unknown, field = "") =>
  (value === undefined || value === null || value === "" || value === false || (value === 0 && !ZERO_MEANS_ZERO.has(field)) ? null : value === true ? 1 : value);

/**
 * A sequence reduced to what publishing it would change, as text. Two docs with the same
 * fingerprint publish the same thing, however they were arrived at: an absent field and an
 * empty one are the same, and so are a gate with its default outcomes spelled out or not.
 */
export function fingerprint(doc: Doc): string {
  const draft = draftOf(doc);
  const outcome = (value: Outcome) => ({ then: value.then, step: value.then === "jump" ? value.step ?? null : null, effects: value.effects?.length ? value.effects : null });
  return JSON.stringify({
    steps: draft.steps.map((step) => ({
      ref: step.id ?? step.key, track: step.track,
      ...Object.fromEntries(STEP_FIELDS.map((field) => [field, blank((step as unknown as Record<string, unknown>)[field], field)])),
      templates: step.step_type === "delay" || step.step_type === "visit" || step.step_type === "connect" ? [] : [...(step.template_ids ?? []), ...(step.template_id && !(step.template_ids ?? []).length ? [step.template_id] : [])],
      versions: step.step_type === "email" ? (step.email_variants ?? []).map((variant) => ({ id: variant.id ?? null, subject: variant.subject ?? "", body: variant.body ?? "", weight: variant.weight ?? null })) : [],
    })),
    gates: draft.gates.map((gate) => ({ source: gate.source, kind: gate.kind, conditions: gate.kind === "conditions" ? gate.conditions : null, on_true: outcome(gate.on_true!), on_false: outcome(gate.on_false!) }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    settings: { email_start: draft.settings.email_start, linkedin: Boolean(draft.settings.linkedin_track_enabled), email: Boolean(draft.settings.email_track_enabled) },
  });
}

// ── Changing it ───────────────────────────────────────────────────────────────

const withLane = (doc: Doc, track: Track, lane: Row[]): Doc => ({ ...doc, [track]: lane });
const laneOf = (doc: Doc, ref: string): Track | null => (doc.linkedin.some((row) => row.ref === ref) ? "linkedin" : doc.email.some((row) => row.ref === ref) ? "email" : null);

export const STEP_CHOICES: Record<Track, Array<{ type: SendType; label: string; hint: string }>> = {
  linkedin: [
    { type: "visit", label: "Profile visit", hint: "Look at their profile, so your name shows up first" },
    { type: "connect", label: "Connection request", hint: "With or without a note" },
    { type: "message", label: "LinkedIn message", hint: "To a contact who is connected" },
    { type: "sales_inmail", label: "Sales Navigator InMail", hint: "Reaches someone who is not connected" },
  ],
  email: [{ type: "email", label: "Email", hint: "A first email or a follow-up" }],
};

function blankStep(track: Track, type: SendType): Row {
  const ref = newRef();
  if (type === "email") return { ref, key: ref, track, step_type: "email", email_subject: "", email_body: "", email_delivery_mode: "plain", email_track_opens: 0, email_track_clicks: 0, email_in_thread: 0, email_variants: [], template_ids: [] };
  if (type === "connect") return { ref, key: ref, track, step_type: "connect", connect_note: "" };
  if (type === "visit") return { ref, key: ref, track, step_type: "visit" };
  return { ref, key: ref, track, step_type: type, message_body: "", ...(type === "sales_inmail" ? { email_subject: "" } : {}), template_ids: [] };
}

/** Add a step at the end of a track, a day after whatever comes before it. Returns the new step's ref. */
export function addStep(doc: Doc, track: Track, type: SendType): { doc: Doc; ref: string } {
  const lane = doc[track];
  const step = blankStep(track, type);
  const needsWait = lane.some(isSending) && lane[lane.length - 1]?.step_type !== "delay";
  const wait: Row[] = needsWait ? [{ ref: newRef(), track, step_type: "delay", delay_seconds: DAY }] : [];
  for (const row of wait) row.key = row.ref;
  return { doc: withLane(doc, track, [...lane, ...wait, step]), ref: step.ref };
}

export function updateRow(doc: Doc, ref: string, patch: Partial<StepInput>): Doc {
  const track = laneOf(doc, ref);
  return track ? withLane(doc, track, doc[track].map((row) => (row.ref === ref ? { ...row, ...patch } : row))) : doc;
}

/** The wait that comes straight before a row, if there is one. */
export function waitBefore(doc: Doc, ref: string): Row | null {
  const track = laneOf(doc, ref);
  if (!track) return null;
  const index = doc[track].findIndex((row) => row.ref === ref);
  const previous = doc[track][index - 1];
  return previous?.step_type === "delay" ? previous : null;
}

/** Set how long to wait before a step. Nothing removes the wait, unless a condition sits on it. */
export function setWaitBefore(doc: Doc, ref: string, seconds: number): Doc {
  const track = laneOf(doc, ref);
  if (!track) return doc;
  const lane = doc[track];
  const index = lane.findIndex((row) => row.ref === ref);
  const wait = waitBefore(doc, ref);
  const amount = Math.max(0, Math.round(seconds));
  if (wait) {
    if (amount === 0 && !gateOn(doc, wait.ref)) return withLane(doc, track, lane.filter((row) => row.ref !== wait.ref));
    return updateRow(doc, wait.ref, { delay_seconds: Math.max(amount, HOUR) });
  }
  if (amount === 0) return doc;
  const added: Row = { ref: newRef(), track, step_type: "delay", delay_seconds: amount };
  added.key = added.ref;
  return withLane(doc, track, [...lane.slice(0, index), added, ...lane.slice(index)]);
}

/** Take a row out, with the wait before it (unless a condition sits on that) and any condition on it. Jumps to it carry on instead. */
export function removeRow(doc: Doc, ref: string): Doc {
  const track = laneOf(doc, ref);
  if (!track) return doc;
  const row = findRow(doc, ref)!;
  const wait = isSending(row) ? waitBefore(doc, ref) : null;
  const gone = new Set([ref, ...(wait && !gateOn(doc, wait.ref) ? [wait.ref] : [])]);
  const land = (outcome: Outcome): Outcome => (outcome.then === "jump" && outcome.step && gone.has(outcome.step) ? { ...outcome, then: "continue", step: null } : outcome);
  return {
    ...doc,
    [track]: doc[track].filter((candidate) => !gone.has(candidate.ref)),
    gates: doc.gates.filter((gate) => !gone.has(gate.source)).map((gate) => ({ ...gate, on_true: land(gate.on_true), on_false: land(gate.on_false) })),
  };
}

/**
 * Move a step, with the wait before it, to just before another step of the same track, or
 * to the end when `beforeRef` is null. A step keeps its own wait wherever it goes.
 */
export function moveStep(doc: Doc, ref: string, beforeRef: string | null): Doc {
  const track = laneOf(doc, ref);
  if (!track || ref === beforeRef || (beforeRef !== null && laneOf(doc, beforeRef) !== track)) return doc;
  const lane = doc[track];
  const blockOf = (target: string): Row[] => {
    const index = lane.findIndex((row) => row.ref === target);
    const previous = lane[index - 1];
    return previous?.step_type === "delay" && !gateOn(doc, previous.ref) ? [previous, lane[index]] : [lane[index]];
  };
  const moving = blockOf(ref);
  const rest = lane.filter((row) => !moving.includes(row));
  if (beforeRef === null) return withLane(doc, track, [...rest, ...moving]);
  // Land in front of the other step's own wait, so that step keeps it.
  const anchor = blockOf(beforeRef).filter((row) => !moving.includes(row))[0];
  const at = rest.indexOf(anchor);
  if (at === -1) return doc;
  return withLane(doc, track, [...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

/** Move a step one place earlier or later among the steps of its track. For the keyboard. */
export function nudgeStep(doc: Doc, ref: string, direction: -1 | 1): Doc {
  const track = laneOf(doc, ref);
  if (!track) return doc;
  const steps = doc[track].filter(isSending);
  const index = steps.findIndex((row) => row.ref === ref);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= steps.length) return doc;
  return direction === -1 ? moveStep(doc, ref, steps[target].ref) : moveStep(doc, ref, steps[target + 1]?.ref ?? null);
}

export function setGate(doc: Doc, source: string, gate: Omit<Gate, "source"> | null): Doc {
  const others = doc.gates.filter((candidate) => candidate.source !== source);
  return { ...doc, gates: gate ? [...others, { ...gate, source }] : others };
}

/** A new condition for a row: the first kind that belongs there, doing what the engine does by default. */
export function defaultGate(row: Pick<StepInput, "step_type">): Omit<Gate, "source"> {
  const kind = gateKindsFor(row)[0];
  return { kind, ...(kind === "conditions" ? { conditions: { mode: "all", conditions: [{ field: "replied", operator: "exists" }] } } : {}), on_true: { then: DEFAULT_OUTCOME[kind].true }, on_false: { then: DEFAULT_OUTCOME[kind].false } };
}

/** Put one step back as it was in an earlier state of the sequence: its own fields and the wait before it. Everything else is left alone. */
export function restoreStep(doc: Doc, earlier: Doc, ref: string): Doc {
  const was = findRow(earlier, ref);
  const track = laneOf(doc, ref);
  if (!was || !track) return doc;
  const replaced = withLane(doc, track, doc[track].map((row) => (row.ref === ref ? was : row)));
  const wait = Math.max(0, Number(waitBefore(earlier, ref)?.delay_seconds) || 0);
  const now = Math.max(0, Number(waitBefore(replaced, ref)?.delay_seconds) || 0);
  return wait === now ? replaced : setWaitBefore(replaced, ref, wait);
}

/** Put the condition on one row back as it was in an earlier state of the sequence (which may be: none). */
export function restoreGate(doc: Doc, earlier: Doc, source: string): Doc {
  const was = gateOn(earlier, source);
  return setGate(doc, source, was ? { kind: was.kind, conditions: was.conditions, on_true: was.on_true, on_false: was.on_false } : null);
}

// ── What a track looks like ───────────────────────────────────────────────────

export interface LaneItem {
  row: Row;
  /** The day of a contact's time in this track that a step falls on. Null for a wait. */
  day: number | null;
  /** "Email 2", "LinkedIn message": which of its kind this is. */
  number: number;
  gate: Gate | null;
}

export function laneItems(doc: Doc, track: Track): LaneItem[] {
  let elapsed = 0;
  const seen: Record<string, number> = {};
  return doc[track].map((row) => {
    if (row.step_type === "delay") {
      elapsed += Math.max(0, Number(row.delay_seconds) || 0);
      return { row, day: null, number: 0, gate: gateOn(doc, row.ref) };
    }
    const kind = row.step_type === "sales_inmail" ? "message" : row.step_type;
    seen[kind] = (seen[kind] ?? 0) + 1;
    return { row, day: 1 + Math.floor(elapsed / DAY), number: seen[kind], gate: gateOn(doc, row.ref) };
  });
}

export const stepCount = (doc: Doc, track: Track) => doc[track].filter(isSending).length;

/** "Wait 2 days", "Wait 6 hours", "Wait 1 day 12 hours". */
export function waitLabel(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / DAY);
  const hours = Math.round((total - days * DAY) / HOUR);
  if (days === 0 && hours === 0) return "No wait";
  const parts = [days > 0 ? `${days} ${plural(days, "day", "days")}` : "", hours > 0 ? `${hours} ${plural(hours, "hour", "hours")}` : ""].filter(Boolean);
  return `Wait ${parts.join(" ")}`;
}

export function stepTitle(item: LaneItem): string {
  const { row, number } = item;
  switch (row.step_type) {
    case "visit": return "Profile visit";
    case "connect": return row.connect_note?.trim() ? "Connection request + note" : "Connection request";
    case "sales_inmail": return "Sales Navigator InMail";
    case "message": return number <= 1 ? "LinkedIn message" : number === 2 ? "LinkedIn follow-up" : `LinkedIn follow-up ${number - 1}`;
    case "email": return row.email_subject?.trim() && !isOn(row.ai_enabled) ? `Email ${number} — ${row.email_subject.trim()}` : `Email ${number}`;
    default: return waitLabel(row.delay_seconds);
  }
}

export const STEP_KIND_LABEL: Record<string, string> = { visit: "Profile visit", connect: "Connection request", message: "LinkedIn message", sales_inmail: "InMail", email: "Email step", delay: "Wait" };

const share = (part: number, whole: number) => formatPercent(rate(part, whole));
const excerpt = (text: string | null | undefined, max = 64) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The second line of a step card: what it has done so far, or failing that what it will do. */
export function stepSubline(row: Row, figures: StepFigures | undefined, templates: number): string {
  if (figures && figures.sent > 0) {
    const sent = formatCount(figures.sent);
    if (row.step_type === "visit") return `${sent} visited`;
    if (row.step_type === "connect") return `${sent} sent · ${share(figures.accepted, figures.requests || figures.sent)} accepted`;
    if (row.step_type === "email") {
      const opened = isOn(row.email_track_opens) || figures.opened > 0 ? ` · ${share(figures.opened, figures.sent)} opened` : "";
      return `${sent} sent${opened} · ${share(figures.replied, figures.sent)} replied`;
    }
    return `${sent} sent · ${share(figures.replied, figures.sent)} replied`;
  }
  if (row.step_type === "visit") return "Warms the profile before you write";
  if (row.step_type === "connect") return row.connect_note?.trim() ? excerpt(row.connect_note) : "Sent without a note";
  if (isOn(row.ai_enabled)) return "Written by AI for each contact";
  if (templates > 0) return `Rotates ${templates} ${plural(templates, "template", "templates")}`;
  const text = row.step_type === "email" ? row.email_body : row.message_body;
  return excerpt(text) || "Nothing written yet";
}

/** The four numbers at the top of a step's panel. */
export function performance(row: Row, figures: StepFigures | undefined): Array<{ label: string; value: string; tone?: "li" | "mail" | "warn" }> {
  const sent = figures?.sent ?? 0;
  const pct = (part: number, whole = sent) => (whole > 0 ? share(part, whole) : "—");
  if (row.step_type === "visit") return [{ label: "Visited", value: formatCount(sent) }, { label: "Contacts", value: formatCount(figures?.contacts ?? 0) }];
  if (row.step_type === "connect") return [
    { label: "Sent", value: formatCount(sent) }, { label: "Accepted", value: pct(figures?.accepted ?? 0, figures?.requests || sent), tone: "li" }, { label: "Replied", value: pct(figures?.replied ?? 0), tone: "mail" },
  ];
  if (row.step_type === "email") return [
    { label: "Sent", value: formatCount(sent) }, { label: "Opened", value: pct(figures?.opened ?? 0), tone: "li" },
    { label: "Replied", value: pct(figures?.replied ?? 0), tone: "mail" }, { label: "Bounced", value: pct(figures?.bounced ?? 0), tone: "warn" },
  ];
  return [{ label: "Sent", value: formatCount(sent) }, { label: "Replied", value: pct(figures?.replied ?? 0), tone: "mail" }];
}

// ── A/B versions ──────────────────────────────────────────────────────────────

export interface Version { index: number; id: string | null; subject: string; body: string; weight: number | null }

/** An email step's versions: A is the step's own text, the rest its variants. */
export function versionsOf(row: Row): Version[] {
  return [
    { index: 0, id: null, subject: row.email_subject ?? "", body: row.email_body ?? "", weight: row.email_control_weight ?? null },
    ...(row.email_variants ?? []).map((variant, index) => ({ index: index + 1, id: variant.id ?? null, subject: variant.subject ?? "", body: variant.body ?? "", weight: variant.weight ?? null })),
  ];
}

/** Each version's share of sends, in whole percents that add up to 100. Unset weights count as equal. */
export function versionShares(versions: Array<Pick<Version, "weight">>): number[] {
  const custom = versions.some((version) => version.weight != null) && new Set(versions.map((version) => version.weight ?? 1)).size > 1;
  const weights = versions.map((version) => (custom ? version.weight ?? 1 : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) => Math.floor((weight / total) * 100));
  // Hand the rounding remainder to the first versions, so the row always reads 100%.
  for (let left = 100 - shares.reduce((sum, value) => sum + value, 0), index = 0; left > 0; left--, index = (index + 1) % shares.length) shares[index] += 1;
  return shares;
}

export function splitLabel(versions: Array<Pick<Version, "weight">>): string {
  const shares = versionShares(versions);
  return new Set(shares).size === 1 ? `Even split · ${shares[0]}% each` : `Split ${shares.map((value, index) => `${letter(index)} ${value}%`).join(" · ")}`;
}

/** Sends a version needs before it is worth calling it ahead. */
export const LEADER_MIN_SENDS = 30;

/**
 * Which version is ahead on replies, if any is: it needs enough sends, and a better reply
 * rate than every other version that also has enough.
 */
export function leader(row: Row, figures: VersionFigures[] | undefined): { index: number; rate: number } | null {
  if (!figures) return null;
  // A version added since the last save has no id and no sends, so it never matches here.
  const ids = [null, ...(row.email_variants ?? []).map((variant) => variant.id ?? "unsaved")];
  const ranked = figures
    .map((entry) => ({ index: ids.indexOf(entry.variant_id), sent: entry.sent, rate: entry.sent > 0 ? entry.replied / entry.sent : 0 }))
    .filter((entry) => entry.index >= 0 && entry.sent >= LEADER_MIN_SENDS)
    .sort((a, b) => b.rate - a.rate);
  if (ranked.length < 2 || ranked[0].rate === ranked[1].rate) return null;
  return { index: ranked[0].index, rate: ranked[0].rate };
}

// ── Gates ─────────────────────────────────────────────────────────────────────

export const GATE_KIND_LABEL: Record<GateKind, string> = {
  connected: "Connection accepted", no_reply: "No reply yet", verified_email: "Verified email found", conditions: "Something about the contact",
};

export const CONDITION_FIELDS: Array<{ field: string; label: string; type: "yes_no" | "number" | "signal" }> = [
  { field: "replied", label: "Replied", type: "yes_no" },
  { field: "connected", label: "Connected on LinkedIn", type: "yes_no" },
  { field: "email_found", label: "Has an email address", type: "yes_no" },
  { field: "intent_score", label: "Intent score", type: "number" },
  { field: "signal_exists", label: "Has a signal", type: "signal" },
];
export const SIGNAL_TYPES = [
  { value: "job_change", label: "Job change" }, { value: "funding", label: "Funding" }, { value: "hiring", label: "Hiring" },
  { value: "technology", label: "Technology" }, { value: "product_intent", label: "Product intent" }, { value: "custom", label: "Custom" },
];
const OPERATOR_WORDS: Record<string, string> = { is: "is", is_not: "is not", contains: "contains", exists: "is set", not_exists: "is not set", gt: ">", gte: "≥", lt: "<", lte: "≤" };

const truthy = (value: unknown) => value === true || value === 1 || String(value).toLowerCase() === "true";
/** Whether a yes-or-no condition asks for "no". The builder writes these as set / not set; older ones compare with true or false. */
export const isNegative = (condition: WorkflowCondition): boolean =>
  condition.operator === "not_exists" || (condition.operator === "is" && !truthy(condition.value)) || (condition.operator === "is_not" && truthy(condition.value));

function conditionWords(condition: WorkflowCondition, customFields: BuilderData["custom_fields"]): string {
  const known = CONDITION_FIELDS.find((candidate) => candidate.field === condition.field);
  if (known?.type === "yes_no") return isNegative(condition) ? `not ${known.label.toLowerCase()}` : known.label.toLowerCase();
  if (known?.type === "signal") return `has a ${(SIGNAL_TYPES.find((signal) => signal.value === condition.value)?.label ?? String(condition.value ?? "custom")).toLowerCase()} signal`;
  const name = known?.label.toLowerCase() ?? (condition.field.startsWith("custom.") ? customFields.find((field) => field.key === condition.field.slice(7))?.name ?? condition.field.slice(7) : condition.field);
  const valueless = condition.operator === "exists" || condition.operator === "not_exists";
  return `${name} ${OPERATOR_WORDS[condition.operator] ?? condition.operator}${valueless ? "" : ` ${String(condition.value ?? "")}`}`.trim();
}

export function gateTitle(gate: Gate, customFields: BuilderData["custom_fields"] = []): string {
  if (gate.kind === "connected") return "If connection accepted";
  if (gate.kind === "no_reply") return "If no reply yet";
  if (gate.kind === "verified_email") return "If verified email found";
  const conditions = gate.conditions?.conditions ?? [];
  if (conditions.length === 0) return "If… (no condition chosen yet)";
  return `If ${conditions.map((condition) => conditionWords(condition, customFields)).join(gate.conditions?.mode === "any" ? " or " : " and ")}`;
}

export function gateSubline(gate: Gate): string {
  if (gate.kind === "connected") return "Decided when the request is accepted, or given up on";
  if (gate.kind === "no_reply") return "A reply on any channel takes the contact out";
  if (gate.kind === "verified_email") return "Checked before this email is sent";
  return "Checked when the step above is done";
}

/** What one side of a gate does, in the words on its card. `steps` are the track's steps, to name a jump's destination. */
export function outcomeLabel(outcome: Outcome, side: "true" | "false", gate: Gate, titles: Map<string, string>, lists: BuilderData["lists"] = []): string {
  const main = (() => {
    switch (outcome.then) {
      case "continue": return gate.kind === "verified_email" && side === "true" ? "Send this email" : "Continue to the next step";
      case "jump": return `Skip ahead to ${outcome.step ? titles.get(outcome.step) ?? "a step since removed" : "…"}`;
      case "end_track": return gate.kind === "verified_email" ? "LinkedIn only: skip the email track" : "Stop this track";
      case "leave": return gate.kind === "no_reply" ? "Leave the sequence as replied" : "Leave the sequence";
      case "handover_email": return "Hand over to the email track";
    }
  })();
  const extras = (outcome.effects ?? []).map((effect) => (effect.type === "add_to_list" ? `add to ${lists.find((list) => list.id === effect.list_id)?.name ?? "a list"}` : `task: ${effect.title}`));
  return extras.length ? `${main} · ${extras.join(" · ")}` : main;
}

/** The outcomes that make sense on one side of a gate, given its kind and the track it is on. */
export function outcomeChoices(gate: Pick<Gate, "kind">, side: "true" | "false", track: Track, laterSteps: number): Array<{ value: OutcomeAction; label: string }> {
  if (gate.kind === "no_reply" && side === "false") return [{ value: "leave", label: "Leave the sequence as replied" }];
  const all: Array<{ value: OutcomeAction; label: string }> = [
    { value: "continue", label: gate.kind === "verified_email" && side === "true" ? "Send this email" : "Continue to the next step" },
    ...(laterSteps > 0 ? [{ value: "jump" as const, label: "Skip ahead to a later step" }] : []),
    { value: "end_track", label: track === "email" ? "Stop the email track" : "Stop the LinkedIn track" },
    ...(track === "linkedin" ? [{ value: "handover_email" as const, label: "Hand over to the email track" }] : []),
    { value: "leave", label: "Leave the sequence" },
  ];
  return all;
}

/** Which kinds of gate can sit on a row. */
export function gateKindsFor(row: Pick<StepInput, "step_type">): GateKind[] {
  if (row.step_type === "connect") return ["connected", "no_reply", "conditions"];
  if (row.step_type === "email") return ["verified_email", "no_reply", "conditions"];
  return ["no_reply", "conditions"];
}

// ── Checking it ───────────────────────────────────────────────────────────────

/** What would stop a step doing its job, in words for its card. Empty when it is ready. */
export function stepProblems(row: Row, templates: BuilderData["templates"], customKeys: readonly string[]): string[] {
  const problems: string[] = [];
  const channel = row.step_type === "email" ? "email" : "linkedin";
  const pool = (row.template_ids ?? []).filter((id) => templates.some((template) => template.id === id && template.channel === channel)).length
    + (channel === "linkedin" && row.template_id && !(row.template_ids ?? []).length ? 1 : 0);
  const ai = isOn(row.ai_enabled);
  if (row.step_type === "connect") {
    if ((row.connect_note ?? "").length > CONNECT_NOTE_LIMIT) problems.push(`The note is over LinkedIn's ${CONNECT_NOTE_LIMIT} characters`);
    problems.push(...lintTemplate(row.connect_note ?? "", customKeys));
  }
  if (row.step_type === "message" || row.step_type === "sales_inmail") {
    if (!ai && pool === 0 && !(row.message_body ?? "").trim()) problems.push("Nothing to send yet: write the message, pick templates, or let AI write it");
    if (row.step_type === "sales_inmail" && !ai && !(row.email_subject ?? "").trim()) problems.push("An InMail needs a subject");
    if (!ai) problems.push(...lintTemplate(`${row.step_type === "sales_inmail" ? row.email_subject ?? "" : ""}\n${row.message_body ?? ""}`, customKeys));
  }
  if (row.step_type === "email" && !ai) {
    if (pool === 0) {
      for (const version of versionsOf(row)) {
        const name = versionsOf(row).length > 1 ? `Version ${letter(version.index)}` : "The email";
        if (!version.subject.trim() && !(isOn(row.email_in_thread))) problems.push(`${name} needs a subject`);
        if (!version.body.trim()) problems.push(`${name} has nothing written yet`);
        problems.push(...lintTemplate(`${version.subject}\n${version.body}`, customKeys, { email: true }));
      }
    }
  }
  if (ai && !(row.ai_prompt ?? "").trim()) problems.push("Tell the AI what this step should say");
  return [...new Set(problems)];
}

/** What would stop the whole sequence being saved. The server checks again; this is so the reason shows before saving. */
export function sequenceProblems(doc: Doc, templates: BuilderData["templates"], customKeys: readonly string[]): Array<{ ref: string | null; message: string }> {
  const problems: Array<{ ref: string | null; message: string }> = [];
  for (const track of TRACKS) {
    const order = new Map(doc[track].map((row, index) => [row.ref, index]));
    for (const item of laneItems(doc, track)) {
      if (isSending(item.row)) for (const message of stepProblems(item.row, templates, customKeys)) problems.push({ ref: item.row.ref, message: `${stepTitle(item)}: ${message}` });
      const gate = item.gate;
      if (!gate) continue;
      if (gate.kind === "conditions" && !(gate.conditions?.conditions ?? []).length) problems.push({ ref: item.row.ref, message: "A condition has nothing chosen to check" });
      for (const outcome of [gate.on_true, gate.on_false]) {
        if (outcome.then !== "jump") continue;
        const to = outcome.step ? order.get(outcome.step) : undefined;
        if (to === undefined || to <= order.get(item.row.ref)!) problems.push({ ref: item.row.ref, message: `${gateTitle(gate)}: a skip must go to a later step of the same track` });
      }
    }
  }
  return problems;
}

// ── Merge tags ────────────────────────────────────────────────────────────────

export interface MergeTag { tag: string; label: string }

/** The tags offered under a message box. `email` adds the one that only an email understands. */
export function mergeTags(customFields: BuilderData["custom_fields"], options: { email?: boolean } = {}): MergeTag[] {
  return [
    { tag: "{{first_name}}", label: "First name" }, { tag: "{{company}}", label: "Company" }, { tag: "{{title}}", label: "Job title" },
    { tag: "{{last_name}}", label: "Last name" }, { tag: "{{location}}", label: "Location" },
    ...customFields.map((field) => ({ tag: `{{custom.${field.key}}}`, label: field.name })),
    { tag: "{{sender.first_name}}", label: "Your first name" }, { tag: "{{sender.name}}", label: "Your name" },
    ...(options.email ? [{ tag: "{{sender.email}}", label: "Your email address" }, { tag: "{{unsubscribe}}", label: "Unsubscribe link" }] : []),
  ];
}

/** Put a tag into text at the caret (or over the selection). Returns the new text and where the caret goes. */
export function insertAt(text: string, insert: string, start: number, end: number): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}

export const AI_LANGUAGES = ["English", "Agent decides", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Polish", "Swedish", "Danish", "Norwegian", "Finnish", "Arabic", "Japanese", "Chinese", "Korean"];
