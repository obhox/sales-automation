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

/**
 * Resolves the contact variables used by live LinkedIn and email sends.
 *
 * Standard `{{first_name}}`-style tokens come from the target row. `custom` is
 * an optional map of workspace-defined custom-field keys → resolved string
 * values (see lib/outreach/custom-values.ts). Unknown tokens are left intact.
 */
export function renderOutreachTemplate(
  body: string,
  target: OutreachTemplateTarget,
  custom?: Record<string, string | null | undefined> | null,
): string {
  let out = body
    .replace(/\{\{\s*first_name\s*\}\}/gi, target.first_name ?? target.full_name?.split(" ")[0] ?? "")
    .replace(/\{\{\s*last_name\s*\}\}/gi, target.last_name ?? target.full_name?.split(" ").slice(1).join(" ") ?? "")
    .replace(/\{\{\s*full_name\s*\}\}/gi, target.full_name ?? "")
    .replace(/\{\{\s*company\s*\}\}/gi, target.company ?? "")
    .replace(/\{\{\s*title\s*\}\}/gi, target.title ?? "")
    .replace(/\{\{\s*location\s*\}\}/gi, target.location ?? "");

  if (custom) {
    for (const [key, value] of Object.entries(custom)) {
      // Only substitute safe snake_case keys; never let a custom key override a standard one.
      if (!/^[a-z][a-z0-9_]*$/i.test(key)) continue;
      if ((STANDARD_VARIABLE_KEYS as readonly string[]).includes(key.toLowerCase())) continue;
      const token = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
      out = out.replace(token, value ?? "");
    }
  }

  return out.trim();
}
