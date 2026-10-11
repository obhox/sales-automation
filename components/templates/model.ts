// What the Templates screen says, worked out from what the library route returns. No
// React here, so the wording can be tested on its own.
import { formatCount, formatPercent, plural } from "@/lib/client/format";
import type { TemplateFigures } from "@/lib/templates/usage";
import type { LibraryTemplate, TemplateLibrary } from "@/pages/api/templates/index";

export type { LibraryTemplate, TemplateFigures, TemplateLibrary };

export const TEMPLATES_PATH = "/api/templates";
export const templatePath = (id: string) => `${TEMPLATES_PATH}/${encodeURIComponent(id)}`;

export type Channel = "linkedin" | "email";
export type ChannelFilter = "all" | Channel;
export const CHANNEL_LABEL: Record<Channel, string> = { linkedin: "LinkedIn", email: "Email" };
/** Stands for "templates with no category" in the category filter. */
export const NO_CATEGORY = "__none";

export const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name" },
  { value: "most_sent", label: "Most sent" },
  { value: "best_reply", label: "Best reply rate" },
] as const;
export type SortKey = (typeof SORTS)[number]["value"];

export function channelCounts(templates: Pick<LibraryTemplate, "channel">[]): Record<ChannelFilter, number> {
  return { all: templates.length, linkedin: templates.filter((t) => t.channel === "linkedin").length, email: templates.filter((t) => t.channel === "email").length };
}

/** "12 templates · 3 categories". */
export function librarySummary(library: TemplateLibrary): string {
  const count = library.templates.length;
  if (count === 0) return "No templates yet";
  const categories = library.categories.length;
  return `${formatCount(count)} ${plural(count, "template", "templates")}${categories > 0 ? ` · ${categories} ${plural(categories, "category", "categories")}` : ""}`;
}

export function categoryOptions(library: TemplateLibrary): Array<{ value: string; label: string }> {
  const uncategorised = library.templates.some((t) => !t.category);
  return [
    { value: "all", label: "All categories" },
    ...library.categories.map((category) => ({ value: category, label: category })),
    ...(uncategorised && library.categories.length > 0 ? [{ value: NO_CATEGORY, label: "No category" }] : []),
  ];
}

/** The share of the people it was sent to who replied. Null before it has been sent. */
export function replyRate(figures: TemplateFigures | null): number | null {
  return figures && figures.contacts > 0 ? figures.replied / figures.contacts : null;
}

/** A rate from fewer sends than this says little, and is shown as such. */
export const FEW_SENDS = 20;

export function matches(template: LibraryTemplate, filter: { channel: ChannelFilter; category: string; q: string }): boolean {
  if (filter.channel !== "all" && template.channel !== filter.channel) return false;
  if (filter.category === NO_CATEGORY ? Boolean(template.category) : filter.category !== "all" && template.category !== filter.category) return false;
  const q = filter.q.trim().toLowerCase();
  if (!q) return true;
  return [template.name, template.body, template.subject ?? "", template.category ?? ""].some((text) => text.toLowerCase().includes(q));
}

export function sortTemplates(templates: LibraryTemplate[], sort: SortKey): LibraryTemplate[] {
  const list = [...templates];
  if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (sort === "most_sent") return list.sort((a, b) => (b.figures?.sent ?? 0) - (a.figures?.sent ?? 0));
  // Templates with no rate yet go last, in the order they came.
  if (sort === "best_reply") return list.sort((a, b) => (replyRate(b.figures) ?? -1) - (replyRate(a.figures) ?? -1));
  return list;
}

/** One line of the message for the table: its subject if it has one, else where the body begins. */
export function previewLine(template: Pick<LibraryTemplate, "subject" | "body">): string {
  const text = (template.subject?.trim() ? template.subject : template.body).replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 95).trimEnd()}…` : text;
}

/** "2 steps in 2 campaigns", "1 step", or that no step offers it. */
export function usedIn(figures: TemplateFigures | null): string {
  if (!figures || figures.steps === 0) return "Not in a step";
  const steps = `${figures.steps} ${plural(figures.steps, "step", "steps")}`;
  return figures.campaigns > 1 ? `${steps} in ${figures.campaigns} campaigns` : steps;
}

export interface FigureCells {
  sent: string;
  /** "14 · 10.9%", or a dash before it has been sent. */
  replies: string;
  positive: string;
  /** True when there are too few sends for the rate to mean much. */
  thin: boolean;
}

export function figureCells(figures: TemplateFigures | null): FigureCells {
  if (!figures || figures.sent === 0) return { sent: "—", replies: "—", positive: "—", thin: false };
  const rate = replyRate(figures);
  return {
    sent: formatCount(figures.sent),
    replies: figures.replied > 0 && rate !== null ? `${formatCount(figures.replied)} · ${formatPercent(rate)}` : "0",
    positive: figures.replied > 0 ? formatCount(figures.positive) : "—",
    thin: figures.sent < FEW_SENDS,
  };
}

/** What deleting a template touches, for the confirmation. */
export function deleteWarning(template: LibraryTemplate): string {
  const figures = template.figures;
  const steps = figures?.steps ?? 0;
  const offered = steps > 0
    ? `${steps === 1 ? "One step offers" : `${steps} steps offer`} this template${figures!.campaigns > 1 ? `, across ${figures!.campaigns} campaigns` : ""}. ${steps === 1 ? "It" : "They"} will stop offering it, and a step left with no template sends its own wording, or nothing if it has none. `
    : "";
  const history = figures && figures.sent > 0 ? `It has been sent ${formatCount(figures.sent)} ${plural(figures.sent, "time", "times")}: those messages stay sent, and reports will call it "a template since removed". ` : "";
  return `${offered}${history}This cannot be undone.`;
}

/** A name for a copy that no other template has: "Intro (copy)", then "Intro (copy 2)". */
export function copyName(name: string, taken: string[]): string {
  const used = new Set(taken.map((item) => item.toLowerCase()));
  const base = name.replace(/ \(copy(?: \d+)?\)$/, "");
  for (let n = 1; ; n += 1) {
    const candidate = `${base} (copy${n === 1 ? "" : ` ${n}`})`.slice(0, 200);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export interface TemplateForm {
  name: string;
  channel: Channel;
  category: string;
  subject: string;
  body: string;
}

export const blankForm = (channel: Channel = "linkedin"): TemplateForm => ({ name: "", channel, category: "", subject: "", body: "" });
export const formOf = (template: LibraryTemplate): TemplateForm => ({ name: template.name, channel: template.channel, category: template.category ?? "", subject: template.subject ?? "", body: template.body });

/** What is wrong with a template as typed, and with which field. Null when it can be saved. */
export function formProblem(form: TemplateForm): { field: "name" | "subject" | "body"; message: string } | null {
  if (!form.name.trim()) return { field: "name", message: "Give the template a name." };
  if (!form.body.trim()) return { field: "body", message: "Write the message." };
  if (form.channel === "email" && !form.subject.trim()) return { field: "subject", message: "An email needs a subject line." };
  return null;
}

/** What is sent to the API. A LinkedIn message has no subject; an empty category clears it. */
export function payloadOf(form: TemplateForm): Record<string, string> {
  return { name: form.name.trim(), channel: form.channel, category: form.category.trim(), subject: form.channel === "email" ? form.subject.trim() : "", body: form.body };
}
