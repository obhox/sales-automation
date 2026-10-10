// The rules for contact tags, shared by the route and the screen.

/** A tag's colour is one of the design system's tones, by name. */
export const CONTACT_TAG_COLORS = ["neutral", "brand", "good", "warn", "bad", "li", "mail"] as const;
export type ContactTagColor = (typeof CONTACT_TAG_COLORS)[number];

export const MAX_TAG_NAME = 32;
export const MAX_TAGS = 200;

/** The tag's name, trimmed, or a sentence saying why it was refused. */
export function tagName(value: unknown): { name: string } | string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return "A tag needs a name";
  if (name.length > MAX_TAG_NAME) return `A tag name can be up to ${MAX_TAG_NAME} characters`;
  return { name };
}

/** A colour the screen can draw; anything else becomes the neutral grey. */
export function tagColor(value: unknown): ContactTagColor {
  return (CONTACT_TAG_COLORS as readonly string[]).includes(String(value)) ? (value as ContactTagColor) : "neutral";
}
