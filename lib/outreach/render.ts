import { seededPick } from "@/lib/outreach/seed";

export interface OutreachTemplateTarget {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
}

/** Reserved variable names resolved from the target row itself. Custom fields
 *  cannot shadow these. */
export const STANDARD_VARIABLE_KEYS = [
  "first_name", "last_name", "full_name", "company", "title", "location",
] as const;

/** Who a message goes out from: the mailbox for an email, the LinkedIn account for the rest. */
export interface OutreachSender {
  name?: string | null;
  email?: string | null;
}

/**
 * Tags about the sender, written `{{sender.name}}`. They let one step be sent from several
 * mailboxes or LinkedIn accounts and still sign off as whoever it came from.
 */
export const SENDER_VARIABLE_KEYS = ["sender.name", "sender.first_name", "sender.email"] as const;

/** Read whichever of a mailbox's or a LinkedIn account's columns name the sender. */
export function senderOf(row: { from_name?: string | null; name?: string | null; from_email?: string | null; email?: string | null } | null | undefined): OutreachSender {
  return { name: row?.from_name || row?.name || null, email: row?.from_email || row?.email || null };
}

/**
 * Tags that mean something only in an email, and are filled when it is sent rather than
 * here, because what they stand for (a link signed for that one email) does not exist
 * until the email does. `{{unsubscribe}}` is the link that lets a recipient opt out; with
 * `{{unsubscribe|words}}`, the words are what the link says.
 */
export const EMAIL_TAGS = ["unsubscribe"] as const;

const TAG = /\{\{([^{}]*)\}\}/g;
// A single-brace group with at least one "|" and no braces inside: the innermost alternatives.
const SPIN = /\{([^{}|]*(?:\|[^{}|]*)+)\}/;
// Stand-in for a merge tag while spintax is worked out, so neither sees the other's braces.
const MASK = (i: number) => `\u0000${i}\u0000`;
const MASKED = /\u0000(\d+)\u0000/g;

/**
 * Turn a message template into the text one contact receives.
 *
 * Merge tags: `{{first_name}}` is filled from the contact; `{{first_name|there}}` uses the
 * text after the bar when the contact has nothing for it. Standard tags come from the target
 * row, the rest from `custom` (workspace custom fields, see lib/outreach/custom-values.ts).
 * A custom field can be written bare (`{{trigger}}`) or as `{{custom.trigger}}`, which says
 * what it is and can never be mistaken for a standard tag. `{{sender.name}}`,
 * `{{sender.first_name}}` and `{{sender.email}}` come from `options.sender`.
 * A tag that names nothing known is left as written, so the mistake shows in a preview
 * rather than vanishing.
 *
 * Wording variation: `{Hi|Hello|Hey}` becomes one of the alternatives, and may be nested.
 * The pick is repeatable for a given `seed`; without one it is random. Alternatives are
 * chosen before tags are filled, so a contact's own data is never read as a choice.
 */
export function renderOutreachTemplate(
  body: string,
  target: OutreachTemplateTarget,
  custom?: Record<string, string | null | undefined> | null,
  options: {
    seed?: string;
    /** Tags to leave exactly as written, bar and all, for a later stage to fill. */
    keep?: readonly string[];
    /** Who the message is from. Without it, sender tags are left as written. */
    sender?: OutreachSender | null;
  } = {},
): string {
  const tags: string[] = [];
  let out = body.replace(TAG, (_whole, inner: string) => MASK(tags.push(inner) - 1));

  for (let group = 0; ; group++) {
    const match = SPIN.exec(out);
    if (!match) break;
    const alternatives = match[1].split("|");
    const chosen = options.seed === undefined
      ? alternatives[Math.floor(Math.random() * alternatives.length)]
      : seededPick(`${options.seed}:${group}`, alternatives);
    out = out.slice(0, match.index) + chosen + out.slice(match.index + match[0].length);
  }

  out = out.replace(MASKED, (_whole, index: string) => resolveTag(tags[Number(index)], target, custom, options.keep, options.sender));
  return out.trim();
}

/** What a tag's inside (`first_name` or `first_name|there`) renders to. */
function resolveTag(inner: string, target: OutreachTemplateTarget, custom?: Record<string, string | null | undefined> | null, keep?: readonly string[], sender?: OutreachSender | null): string {
  const bar = inner.indexOf("|");
  const key = (bar === -1 ? inner : inner.slice(0, bar)).trim().toLowerCase();
  if (keep?.includes(key)) return `{{${inner}}}`;
  const fallback = bar === -1 ? null : inner.slice(bar + 1).trim();
  const value = lookup(key, target, custom, sender);
  // undefined: nothing by that name. Left as written unless the author gave a fallback.
  if (value === undefined) return fallback ?? `{{${inner}}}`;
  return value.trim() === "" && fallback !== null ? fallback : value;
}

function lookup(key: string, target: OutreachTemplateTarget, custom?: Record<string, string | null | undefined> | null, sender?: OutreachSender | null): string | undefined {
  if (key.startsWith("sender.")) {
    // No sender given (a preview with no mailbox chosen): left as written, like any tag nothing answers for.
    if (!sender) return undefined;
    const name = (sender.name ?? "").trim();
    switch (key) {
      case "sender.name": return name;
      case "sender.first_name": return name.split(/\s+/)[0] ?? "";
      case "sender.email": return sender.email ?? "";
      default: return undefined;
    }
  }
  // `custom.` only says which kind of field is meant: the lookup below is the same one.
  if (key.startsWith("custom.")) return customValue(key.slice(7), custom);
  switch (key) {
    case "first_name": return target.first_name ?? target.full_name?.split(" ")[0] ?? "";
    case "last_name": return target.last_name ?? target.full_name?.split(" ").slice(1).join(" ") ?? "";
    case "full_name": return target.full_name ?? "";
    case "company": return target.company ?? "";
    case "title": return target.title ?? "";
    case "location": return target.location ?? "";
  }
  // A custom key can never stand in for a standard one (handled above).
  return customValue(key, custom);
}

/** A workspace custom field's value for this contact. Only safe snake_case keys are looked up. */
function customValue(key: string, custom?: Record<string, string | null | undefined> | null): string | undefined {
  if (!custom || !/^[a-z][a-z0-9_]*$/.test(key)) return undefined;
  const match = Object.keys(custom).find((name) => name.toLowerCase() === key);
  return match === undefined ? undefined : custom[match] ?? "";
}

/**
 * What is wrong with a template before anyone receives it: tags that name no field, and
 * braces that do not close. `customKeys` are the workspace's custom-field keys. `email`
 * says the template is an email's, where the email-only tags mean something.
 */
export function lintTemplate(body: string, customKeys: readonly string[] = [], options: { email?: boolean } = {}): string[] {
  const customs = customKeys.map((key) => key.toLowerCase());
  const known = new Set<string>([...STANDARD_VARIABLE_KEYS, ...SENDER_VARIABLE_KEYS, ...customs, ...customs.map((key) => `custom.${key}`)]);
  const emailTags = new Set<string>(EMAIL_TAGS);
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const misplaced = new Set<string>();
  const rest = body.replace(TAG, (_whole, inner: string) => {
    const key = inner.split("|")[0].trim().toLowerCase();
    if (emailTags.has(key)) { if (!options.email) misplaced.add(key); }
    else if (!known.has(key)) unknown.add(key || "(empty)");
    return "";
  });
  for (const key of misplaced) warnings.push(`{{${key}}} only works in an email. Here it will be sent as written.`);
  for (const key of unknown) {
    // The commonest slips of the one tag whose misspelling leaves a recipient with no way out.
    const meant = options.email && /^(unsub|unsus|opt[_-]?out)/.test(key) ? " Did you mean {{unsubscribe}}?" : "";
    const what = key.startsWith("sender.") ? `{{${key}}} is not something known about the sender` : key.startsWith("custom.") ? `{{${key}}} is not one of this workspace's custom fields` : `{{${key}}} is not a field on a contact`;
    warnings.push(`${what}. It will be sent as written.${meant}`);
  }
  if (rest.includes("{{") || rest.includes("}}")) warnings.push("A {{tag}} is not closed properly. Check the double braces.");
  let leftover = rest.replace(/\{\{|\}\}/g, "");
  while (SPIN.test(leftover)) leftover = leftover.replace(SPIN, "");
  if (/\{[^{}]*\|/.test(leftover) || /\|[^{}]*\}/.test(leftover)) warnings.push("A {choice|of|words} is not closed properly. Check the single braces.");
  return warnings;
}
