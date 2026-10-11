// What the Companies screen knows about a company, and how it words it. No React in here,
// so the wording can be tested.
import type { BounceFigures, CompaniesSummary, CompanyBounce, CompanyContact, CompanyDetail, CompanyFilter, CompanyRow, CompanySignal, CompanySuggestion } from "@/lib/companies/overview";
import { formatCount, formatDate, formatPercent, formatRelative, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";

export type { BounceFigures, CompaniesSummary, CompanyBounce, CompanyContact, CompanyDetail, CompanyFilter, CompanyRow, CompanySignal, CompanySuggestion };

export const COMPANIES_PATH = "/api/companies";
export const COMPANY_ENRICH_PATH = "/api/companies/enrich";
export const COMPANY_IMPORT_PATH = "/api/companies/import";
export const COMPANY_EXPORT_PATH = "/api/export/companies";
export const SIGNALS_PATH = "/api/platform/signals";
export const companyPath = (id: string) => `/api/companies/${id}`;
export const suggestionsPath = (id: string) => `/api/companies/${id}/suggestions`;
export const bouncesPath = (id: string) => `/api/companies/${id}/bounces`;

export interface CompaniesPage {
  items: CompanyRow[];
  total: number;
  page: number;
  limit: number;
}

// ── List state ────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 25;
export const FILTER_DEFAULTS = { filter: "all" };
export const TABLE_OPTIONS = { pageSize: PAGE_SIZE, sort: { key: "intent", direction: "desc" as const }, filters: FILTER_DEFAULTS };

export const FILTER_OPTIONS: { value: CompanyFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "contacts", label: "Has contacts" },
  { value: "bouncing", label: "Bouncing" },
  { value: "campaign", label: "In campaign" },
  { value: "target", label: "Targets" },
];

/** The orders the sort menu offers, as `key:direction`. The label is what the button reads. */
export const SORT_OPTIONS = [
  { value: "intent:desc", label: "Intent" },
  { value: "name:asc", label: "Name" },
  { value: "contacts:desc", label: "Contacts" },
  { value: "employees:desc", label: "Employees" },
  { value: "created:desc", label: "Newest" },
];

// ── The list ──────────────────────────────────────────────────────────────────

export const accountsNoun = (count: number) => `${formatCount(count)} ${plural(count, "account", "accounts")}`;
export const contactsNoun = (count: number) => `${formatCount(count)} ${plural(count, "contact", "contacts")}`;
export const bouncingLine = (count: number) => `${formatCount(count)} ${plural(count, "domain", "domains")} bouncing`;

/** "northwindlog.com · 1,840 employees" under a company's name. */
export function subLine(row: Pick<CompanyRow, "domain" | "employee_count">): string {
  const parts = [row.domain, row.employee_count ? `${formatCount(row.employee_count)} ${plural(row.employee_count, "employee", "employees")}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No domain yet";
}

/** "14 of 3,112" under the list. */
export const rangeLine = (shown: number, total: number) => (total === 0 ? "No companies" : `${formatCount(shown)} of ${formatCount(total)}`);

/** Intent reads green from 70, amber from 40, and grey below: the scale a contact's uses. */
export const intentTone = (score: number): Tone => (score >= 70 ? "good" : score >= 40 ? "warn" : "neutral");

const MARK_TONES: Tone[] = ["brand", "li", "mail", "good", "warn", "neutral"];
/** A company keeps one colour for its initials wherever it is shown. */
export function markTone(name: string): Tone {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return MARK_TONES[hash % MARK_TONES.length];
}

/** Two letters for a company: its first two words' initials, or the start of a single word. */
export function markOf(name: string): string {
  const words = name.trim().split(/[\s&/.,-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

// ── A company's header ────────────────────────────────────────────────────────

/** The address "Visit site" opens: the website as typed, or the domain. */
export function siteUrl(company: Pick<CompanyDetail["company"], "website" | "domain">): string | null {
  const raw = company.website?.trim() || company.domain?.trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** "4 linked contacts · 2 active campaigns" beside a company's domain. */
export function metaLine(detail: Pick<CompanyDetail, "contacts" | "campaigns">): string {
  const parts = [`${formatCount(detail.contacts.total)} linked ${plural(detail.contacts.total, "contact", "contacts")}`];
  if (detail.campaigns.length > 0) parts.push(`${detail.campaigns.length} active ${plural(detail.campaigns.length, "campaign", "campaigns")}`);
  return parts.join(" · ");
}

// ── Enrichment ────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = { apollo: "Apollo" };
/** "Source: Apollo · 3 d ago". Without a date the fields came with a contact's look-up, and nobody recorded when. */
export function sourceLabel(company: Pick<CompanyDetail["company"], "enrichment_source" | "enriched_at">, now: Date = new Date()): string {
  if (!company.enrichment_source) return "Not enriched yet";
  const source = `Source: ${SOURCE_LABEL[company.enrichment_source] ?? company.enrichment_source}`;
  return company.enriched_at ? `${source} · ${formatRelative(company.enriched_at, now)}` : source;
}

/** "+8% YoY", "−3% YoY", or null when growth is not known. */
export function growthLabel(growth: number | null): { label: string; tone: Tone } | null {
  if (growth === null || !Number.isFinite(growth)) return null;
  const percent = Math.round(growth * 100);
  if (percent === 0) return { label: "Flat YoY", tone: "neutral" };
  return { label: `${percent > 0 ? "+" : "−"}${Math.abs(percent)}% YoY`, tone: percent > 0 ? "good" : "warn" };
}

const DASH = "—";

/** A revenue figure with its currency sign: Apollo sends "310M". */
const money = (value: string | null) => (value ? (/^[0-9]/.test(value) ? `$${value}` : value) : null);

/** The eight facts on the enrichment card, in two columns of four. A dash stands for what is not known. */
export function enrichmentFields(company: CompanyDetail["company"]): [{ key: string; value: string }[], { key: string; value: string }[]] {
  const growth = growthLabel(company.headcount_growth);
  const employees = company.employee_count ? `${formatCount(company.employee_count)}${growth && growth.label !== "Flat YoY" ? ` (${growth.label})` : ""}` : null;
  const hq = company.location || [company.city, company.country].filter(Boolean).join(", ") || null;
  const ownership = company.stock_symbol ? `Public · ${[company.stock_exchange?.toUpperCase(), company.stock_symbol].filter(Boolean).join(": ")}` : company.enriched_at ? "Not listed" : null;
  const funding = [company.funding_stage, company.funding_amount].filter(Boolean).join(" · ") || (company.funding_total ? `${company.funding_total} raised` : null);
  const field = (key: string, value: string | number | null) => ({ key, value: value === null || value === "" ? DASH : String(value) });
  return [
    [field("Industry", company.industry), field("Employees", employees), field("Revenue", money(company.annual_revenue)), field("Founded", company.founded_year)],
    [field("HQ", hq), field("Ownership", ownership), field("Last funding", funding), field("Domain rank", company.domain_rank ? formatCount(company.domain_rank) : null)],
  ];
}

/** "human_resources" → "Human resources". */
export const departmentLabel = (name: string) => {
  const words = name.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};

export interface DepartmentBar {
  label: string;
  count: number;
  /** 0 to 1 against the largest bar. */
  share: number;
  /** The department a seller sells to. */
  highlight: boolean;
}

/** The headcount card's bars: the largest departments, the rest gathered as "Other". */
export function departmentBars(departments: { name: string; count: number }[], rows = 5): DepartmentBar[] {
  const sorted = [...departments].sort((a, b) => b.count - a.count);
  const top = sorted.length > rows ? sorted.slice(0, rows - 1) : sorted;
  const rest = sorted.slice(top.length).reduce((sum, department) => sum + department.count, 0);
  const bars = [...top.map((department) => ({ label: departmentLabel(department.name), count: department.count, highlight: department.name === "sales" })), ...(rest > 0 ? [{ label: "Other", count: rest, highlight: false }] : [])];
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  return bars.map((bar) => ({ ...bar, share: bar.count / max }));
}

/** The first chips of a long list and how many are held back. */
export function firstOf<T>(items: T[], shown: number): { shown: T[]; more: number } {
  return items.length > shown ? { shown: items.slice(0, shown), more: items.length - shown } : { shown: items, more: 0 };
}

const DOT_TONES: Tone[] = ["li", "mail", "brand", "good", "warn", "neutral"];
/** A steady colour for a technology's dot. */
export function techTone(name: string): Tone {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) >>> 0;
  return DOT_TONES[hash % DOT_TONES.length];
}

// ── Signals ───────────────────────────────────────────────────────────────────

export type SignalKind = "hiring" | "funding" | "job_change" | "technology" | "product_intent" | "custom";
const SIGNAL_KINDS = new Set<string>(["hiring", "funding", "job_change", "technology", "product_intent", "custom"]);
export const signalKind = (type: string): SignalKind => (SIGNAL_KINDS.has(type) ? (type as SignalKind) : "custom");

/** "Rotterdam · Oct 5" under a signal's title. */
export function signalSub(signal: Pick<CompanySignal, "description" | "occurred_at">, now: Date = new Date()): string {
  return [signal.description?.trim() || null, formatDate(signal.occurred_at, now)].filter(Boolean).join(" · ");
}

// ── The bounce warning ────────────────────────────────────────────────────────

export const bounceTitle = (domain: string | null) => (domain ? `Email to ${domain} is bouncing` : "Email to this company is bouncing");

/** What happened and what it means for sending, in two sentences. */
export function bounceDetail(figures: BounceFigures, now: Date = new Date()): string {
  const rate = figures.sends_7d > 0 ? ` (${formatPercent(figures.bounces_7d / figures.sends_7d)} of ${formatCount(figures.sends_7d)} ${plural(figures.sends_7d, "send", "sends")})` : "";
  const what = figures.bounces_7d > 0
    ? `${formatCount(figures.bounces_7d)} hard ${plural(figures.bounces_7d, "bounce", "bounces")} in the last 7 days${rate}.`
    : figures.last_bounce_at ? `The last hard bounce was ${formatRelative(figures.last_bounce_at, now)}.` : "An address here hard-bounced.";
  const held = figures.contacts_with_email > 0
    ? `Email steps for ${formatCount(figures.contacts_with_email)} ${plural(figures.contacts_with_email, "contact", "contacts")} at this account are skipped while this is set; LinkedIn steps carry on.`
    : "Email steps for anyone at this account are skipped while this is set; LinkedIn steps carry on.";
  const checking = figures.verifying > 0 ? ` ${formatCount(figures.verifying)} ${plural(figures.verifying, "address is", "addresses are")} being checked.` : "";
  return `${what} ${held}${checking}`;
}

/** What "Re-verify emails" did. */
export function reverifyOutcome(result: { queued: number; restored: number }): { title: string; description?: string } {
  if (result.queued === 0) return { title: "Nothing to check", description: "Every address here either bounced itself or is on the do-not-send list." };
  return {
    title: `${formatCount(result.queued)} ${plural(result.queued, "address is", "addresses are")} being checked`,
    description: "It runs in the background. The flag stays until someone clears it.",
  };
}

/** What clearing the flag did. */
export function clearOutcome(result: { cleared: boolean; restored: number }, name: string): { title: string; description?: string } {
  if (!result.cleared) return { title: "The flag was already clear" };
  return {
    title: `Email to ${name} is no longer skipped`,
    description: result.restored > 0
      ? `${formatCount(result.restored)} ${plural(result.restored, "colleague's address is", "colleagues' addresses are")} unchecked again. The address that bounced stays on the do-not-send list.`
      : "The address that bounced stays on the do-not-send list.",
  };
}

// ── Apollo: what it costs, and what came of it ────────────────────────────────

export const creditsNoun = (count: number) => `${formatCount(count)} Apollo ${plural(count, "credit", "credits")}`;

export interface EnrichPreview {
  apollo_connected: boolean;
  selected: number;
  eligible: number;
  eligible_ids: string[];
  no_domain: number;
  enriched_before: number;
  capped: boolean;
  credits: number;
  batch: number;
}

/** The lines under the cost of a look-up: who is left out, and who is being asked about again. */
export function enrichNotes(preview: EnrichPreview): string[] {
  const notes: string[] = [];
  if (preview.no_domain > 0) notes.push(`${formatCount(preview.no_domain)} ${plural(preview.no_domain, "company has", "companies have")} no domain, so there is nothing to look up. Nothing is spent on ${plural(preview.no_domain, "it", "them")}.`);
  if (preview.enriched_before > 0) notes.push(`${formatCount(preview.enriched_before)} ${plural(preview.enriched_before, "was", "were")} looked up before. Asking again spends a credit each and brings back what has changed.`);
  if (preview.capped) notes.push(`Only the first ${formatCount(preview.eligible + preview.no_domain)} of ${formatCount(preview.selected)} are taken on at once. Run it again for the rest.`);
  return notes;
}

export interface EnrichProgress {
  total: number;
  done: number;
  enriched: number;
  notFound: number;
  failed: number;
  state: "running" | "stopping" | "stopped" | "finished" | "failed";
  error?: string;
}

/** What a run of look-ups did, in a sentence. */
export function enrichOutcome(progress: EnrichProgress): string {
  const parts = [`${formatCount(progress.enriched)} ${plural(progress.enriched, "company", "companies")} enriched`];
  if (progress.notFound > 0) parts.push(`${formatCount(progress.notFound)} not known to Apollo`);
  if (progress.failed > 0) parts.push(`${formatCount(progress.failed)} failed`);
  const left = progress.total - progress.done;
  if (progress.state === "stopped" && left > 0) parts.push(`${formatCount(left)} not looked up`);
  return parts.join(", ");
}

/** Split ids into the batches a route takes. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** What searching Apollo for people did. */
export function searchOutcome(result: { found: number; added: number }): { title: string; description?: string } {
  if (result.found === 0) return { title: "Apollo lists nobody senior at this domain" };
  if (result.added === 0) return { title: "Nobody new", description: `Apollo named ${formatCount(result.found)} ${plural(result.found, "person", "people")}, all of them contacts already or put aside before.` };
  return { title: `${formatCount(result.added)} ${plural(result.added, "person", "people")} suggested`, description: result.added < result.found ? `${formatCount(result.found - result.added)} more are contacts already or were put aside before.` : undefined };
}

/** What adding suggested people did. */
export function addOutcome(result: { added: number; linked: number; not_found: number; failed: number }): { title: string; description?: string } {
  const made = result.added + result.linked;
  const parts: string[] = [];
  if (result.linked > 0) parts.push(`${formatCount(result.linked)} ${plural(result.linked, "was a contact already and is now linked to this company", "were contacts already and are now linked to this company")}`);
  if (result.not_found > 0) parts.push(`Apollo could not place ${formatCount(result.not_found)}, so ${plural(result.not_found, "that suggestion was", "those suggestions were")} put aside`);
  if (result.failed > 0) parts.push(`${formatCount(result.failed)} failed`);
  const description = parts.length > 0 ? `${parts.join(". ")}.` : undefined;
  if (made === 0) return { title: "Nobody was added", description };
  return { title: `${formatCount(made)} ${plural(made, "contact", "contacts")} added`, description };
}

// ── CSV import ────────────────────────────────────────────────────────────────

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
  ignored_columns: string[];
}

/** What an import did, in a sentence. */
export function importOutcome(result: ImportResult): string {
  const parts = [`${formatCount(result.created)} new`, `${formatCount(result.updated)} updated`];
  if (result.unchanged > 0) parts.push(`${formatCount(result.unchanged)} already up to date`);
  return parts.join(", ");
}

// ── The company form ──────────────────────────────────────────────────────────

export const EMPTY_COMPANY = { name: "", domain: "", website: "", industry: "", location: "", linkedin_url: "", notes: "" };
export type CompanyForm = typeof EMPTY_COMPANY;

export const formOf = (company: CompanyDetail["company"]): CompanyForm => ({
  name: company.name, domain: company.domain ?? "", website: company.website ?? "", industry: company.industry ?? "", location: company.location ?? "",
  linkedin_url: company.linkedin_url ?? "", notes: company.notes ?? "",
});

/** Only what was changed is sent, so an edit cannot blank a field it did not show. */
export function changedFields(before: CompanyForm, after: CompanyForm): Partial<CompanyForm> {
  const changed: Partial<CompanyForm> = {};
  for (const key of Object.keys(after) as (keyof CompanyForm)[]) {
    if (after[key].trim() !== before[key].trim()) changed[key] = after[key].trim();
  }
  return changed;
}
