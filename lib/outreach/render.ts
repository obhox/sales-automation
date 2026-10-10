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
  options: { seed?: string } = {},
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

  out = out.replace(MASKED, (_whole, index: string) => resolveTag(tags[Number(index)], target, custom));
  return out.trim();
}

/** What a tag's inside (`first_name` or `first_name|there`) renders to. */
function resolveTag(inner: string, target: OutreachTemplateTarget, custom?: Record<string, string | null | undefined> | null): string {
  const bar = inner.indexOf("|");
  const key = (bar === -1 ? inner : inner.slice(0, bar)).trim().toLowerCase();
  const fallback = bar === -1 ? null : inner.slice(bar + 1).trim();
  const value = lookup(key, target, custom);
  // undefined: nothing by that name. Left as written unless the author gave a fallback.
  if (value === undefined) return fallback ?? `{{${inner}}}`;
  return value.trim() === "" && fallback !== null ? fallback : value;
}

function lookup(key: string, target: OutreachTemplateTarget, custom?: Record<string, string | null | undefined> | null): string | undefined {
  switch (key) {
    case "first_name": return target.first_name ?? target.full_name?.split(" ")[0] ?? "";
    case "last_name": return target.last_name ?? target.full_name?.split(" ").slice(1).join(" ") ?? "";
    case "full_name": return target.full_name ?? "";
    case "company": return target.company ?? "";
    case "title": return target.title ?? "";
    case "location": return target.location ?? "";
  }
  // Only safe snake_case keys; a custom key can never stand in for a standard one (handled above).
  if (!custom || !/^[a-z][a-z0-9_]*$/.test(key)) return undefined;
  const match = Object.keys(custom).find((name) => name.toLowerCase() === key);
  return match === undefined ? undefined : custom[match] ?? "";
}

/**
 * What is wrong with a template before anyone receives it: tags that name no field, and
 * braces that do not close. `customKeys` are the workspace's custom-field keys.
 */
export function lintTemplate(body: string, customKeys: readonly string[] = []): string[] {
  const known = new Set<string>([...STANDARD_VARIABLE_KEYS, ...customKeys.map((key) => key.toLowerCase())]);
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const rest = body.replace(TAG, (_whole, inner: string) => {
    const key = inner.split("|")[0].trim().toLowerCase();
    if (!known.has(key)) unknown.add(key || "(empty)");
    return "";
  });
  for (const key of unknown) warnings.push(`{{${key}}} is not a field on a contact. It will be sent as written.`);
  if (rest.includes("{{") || rest.includes("}}")) warnings.push("A {{tag}} is not closed properly. Check the double braces.");
  let leftover = rest.replace(/\{\{|\}\}/g, "");
  while (SPIN.test(leftover)) leftover = leftover.replace(SPIN, "");
  if (/\{[^{}]*\|/.test(leftover) || /\|[^{}]*\}/.test(leftover)) warnings.push("A {choice|of|words} is not closed properly. Check the single braces.");
  return warnings;
}
