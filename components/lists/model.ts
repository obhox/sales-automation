// What the Lists screens know about a list, and how they word it. No React in here, so
// the wording can be tested.
import type { ListDetail, ListRow, ListSource, ListState, ListsOverlap, ListsSummary } from "@/lib/lists/overview";
import { formatCount, formatDate, formatPercent, formatRelative, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";

export type { ListDetail, ListRow, ListSource, ListState, ListsOverlap, ListsSummary };

export const LISTS_PATH = "/api/lists";
export const IMPORTS_PATH = "/api/imports";
export const IMPORT_CAP_PATH = "/api/settings/import-cap";
export const listPath = (id: string) => `/api/lists/${id}`;

export interface ListsPage {
  items: ListRow[];
  total: number;
  page: number;
  limit: number;
}

// ── Table state ───────────────────────────────────────────────────────────────

export const FILTER_DEFAULTS = { source: "all", state: "all", owner: "all" };
export type ListFilters = typeof FILTER_DEFAULTS;
export const TABLE_OPTIONS = { pageSize: 25, sort: { key: "updated", direction: "desc" as const }, filters: FILTER_DEFAULTS };
export const PAGE_SIZES = [25, 50, 100];

/** The orders the sort menu offers, as `key:direction`. */
export const SORT_OPTIONS = [
  { value: "updated:desc", label: "Last updated" },
  { value: "name:asc", label: "Name" },
  { value: "contacts:desc", label: "Most contacts" },
  { value: "created:desc", label: "Newest" },
  { value: "enriched:asc", label: "Least enriched" },
  { value: "verified:asc", label: "Least verified" },
];

export const SOURCE_LABEL: Record<ListSource, string> = { sales_navigator: "Sales Navigator", csv: "CSV", manual: "Made by hand" };
export const SOURCE_OPTIONS = [{ value: "all", label: "All sources" }, ...(Object.keys(SOURCE_LABEL) as ListSource[]).map((value) => ({ value, label: SOURCE_LABEL[value] }))];

export const STATE_LABEL: Record<ListState, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  paused: { label: "Paused", tone: "warn" },
  importing: { label: "Importing", tone: "brand" },
  verifying: { label: "Verifying", tone: "brand" },
  needs_enrichment: { label: "Needs enrichment", tone: "warn" },
  ready: { label: "Ready", tone: "neutral" },
  empty: { label: "Empty", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};
export const STATE_OPTIONS = [{ value: "all", label: "All statuses" }, ...(Object.keys(STATE_LABEL) as ListState[]).map((value) => ({ value, label: STATE_LABEL[value].label }))];

// ── Cells ─────────────────────────────────────────────────────────────────────

/** "Mia Chen · created Sep 12" */
export function ownerLine(list: Pick<ListRow, "owner" | "created_at">, now: Date = new Date()): string {
  return [list.owner?.name ?? "No owner", list.created_at ? `created ${formatDate(list.created_at, now)}` : null].filter(Boolean).join(" · ");
}

/** The quiet line under a list's source: when it was last filled, or which file it came from. */
export function sourceLine(list: Pick<ListRow, "source" | "source_detail" | "last_synced_at" | "import">, now: Date = new Date()): string {
  if (list.import) return list.import.status === "running" ? "importing now" : "import queued";
  if (list.source === "csv") return list.source_detail ?? (list.last_synced_at ? `imported ${formatDate(list.last_synced_at, now)}` : "");
  if (list.source === "sales_navigator") return list.last_synced_at ? `synced ${formatRelative(list.last_synced_at, now)}` : "not imported yet";
  return list.last_synced_at ? `last added to ${formatDate(list.last_synced_at, now)}` : "";
}

export interface Share {
  /** 0 to 1, or null when there is nothing to take a share of. */
  ratio: number | null;
  label: string;
  tone: Tone;
  /** Shown in place of a bar when there is no share to draw. */
  note: string | null;
}

const shareTone = (ratio: number): Tone => (ratio >= 0.85 ? "good" : ratio >= 0.5 ? "brand" : "warn");
const share = (part: number, whole: number): Share => {
  const ratio = whole > 0 ? part / whole : null;
  return ratio === null ? { ratio, label: "—", tone: "neutral", note: null } : { ratio, label: formatPercent(ratio, 0), tone: shareTone(ratio), note: null };
};

/** How much of a list has an email address, or has at least been looked up. */
export const enrichedShare = (list: Pick<ListRow, "enriched" | "contacts">): Share => share(list.enriched, list.contacts);

/** How much of a list has an address that passed its check. A list with no addresses has nothing to verify. */
export function verifiedShare(list: Pick<ListRow, "valid" | "with_email" | "contacts">): Share {
  if (list.contacts > 0 && list.with_email === 0) return { ratio: null, label: "—", tone: "neutral", note: "No email addresses" };
  return share(list.valid, list.contacts);
}

/** "2 past campaigns", or a dash for a list no campaign has used. */
export const pastCampaigns = (count: number) => (count > 0 ? `${count} past ${plural(count, "campaign", "campaigns")}` : "—");

export const contactsNoun = (count: number) => `${formatCount(count)} ${plural(count, "contact", "contacts")}`;
export const listsNoun = (count: number) => `${formatCount(count)} ${plural(count, "list", "lists")}`;

/** "12 lists · 48,920 contacts" for the page's title. */
export const totalsLine = (summary: Pick<ListsSummary, "lists" | "contacts">) => `${listsNoun(summary.lists)} · ${contactsNoun(summary.contacts)}`;

export function footerLine(shown: number, total: number, summary: Pick<ListsSummary, "contacts"> | undefined): string {
  if (total === 0) return "No lists";
  const all = summary ? ` · ${contactsNoun(summary.contacts)} in all` : "";
  return `Showing ${formatCount(shown)} of ${listsNoun(total)}${all}`;
}

// ── KPIs ──────────────────────────────────────────────────────────────────────

export interface Kpi {
  label: string;
  value: string;
  note: string;
  noteTone?: "warn";
}

/** The five figures across the top: everything is counted over contacts that are in at least one list. */
export function kpis(summary: ListsSummary): Kpi[] {
  const of = (part: number) => (summary.contacts > 0 ? formatPercent(part / summary.contacts) : "—");
  return [
    { label: "Contacts in lists", value: formatCount(summary.contacts), note: `across ${listsNoun(summary.lists)}` },
    { label: "Enriched", value: of(summary.enriched), note: `${formatCount(summary.enriched)} of ${contactsNoun(summary.contacts)}` },
    {
      label: "Verified emails", value: of(summary.valid),
      note: `${formatCount(summary.valid)} valid · ${formatCount(summary.risky)} risky`, noteTone: summary.risky > 0 ? "warn" : undefined,
    },
    { label: "In active campaigns", value: formatCount(summary.in_campaigns), note: summary.contacts > 0 ? `${formatPercent(summary.in_campaigns / summary.contacts, 0)} of contacts in lists` : "No contacts yet" },
    {
      label: "Apollo look-ups", value: formatCount(summary.apollo_lookups),
      note: summary.apollo_connected ? "in 30 days · one credit each" : "Apollo is not connected",
    },
  ];
}

// ── A selection of lists ──────────────────────────────────────────────────────

/** "7,412 contacts · 1,284 without an email · 212 in more than one list" */
export function selectionLine(overlap: ListsOverlap): string {
  const parts = [contactsNoun(overlap.contacts), `${formatCount(overlap.contacts - overlap.with_email)} without an email`];
  if (overlap.lists > 1) parts.push(`${formatCount(overlap.in_several)} in more than one list`);
  return parts.join(" · ");
}

// ── Imports ───────────────────────────────────────────────────────────────────

export interface ImportJob {
  id: string;
  list_id: string;
  list_name: string | null;
  status: string;
  phase: string | null;
  page: number;
  total_pages: number;
  total: number;
  imported: number;
  skipped: number;
  error: string | null;
  scheduled_for: string | null;
  batch_index: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface ImportsOverview {
  jobs: ImportJob[];
  dailyCap: number;
  importedToday: number;
}

const JOB_STATE: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "brand" },
  scheduled: { label: "Queued", tone: "neutral" },
  done: { label: "Finished", tone: "good" },
  canceled: { label: "Cancelled", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  error: { label: "Failed", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};
export const jobState = (status: string) => JOB_STATE[status] ?? { label: status, tone: "neutral" as Tone };
export const jobIsLive = (job: Pick<ImportJob, "status">) => job.status === "running" || job.status === "scheduled";

/** What an import job has done so far, in a line. */
export function jobLine(job: ImportJob, now: Date = new Date()): string {
  const batch = job.batch_index > 1 ? `Batch ${job.batch_index} · ` : "";
  if (job.status === "scheduled") return `${batch}${job.scheduled_for ? `starts ${formatDate(`${job.scheduled_for}T12:00:00`, now)}` : "waiting its turn"}`;
  if (job.status === "running") {
    const pages = job.total_pages > 0 ? ` · page ${job.page} of ${job.total_pages}` : "";
    return `${batch}${formatCount(job.imported)} imported${job.total > 0 ? ` of ${formatCount(job.total)}` : ""}${pages}`;
  }
  if (job.status === "error" || job.status === "failed") return `${batch}${job.error ?? "The import stopped with an error"}`;
  const skipped = job.skipped > 0 ? `, ${formatCount(job.skipped)} already there` : "";
  return `${batch}${formatCount(job.imported)} imported${skipped}${job.finished_at ? ` · ${formatRelative(job.finished_at, now)}` : ""}`;
}

/** What `GET /api/lists/:id/import-status` answers: the batch that matters now, every batch, and the plan across days. */
export interface ImportStatus {
  status: string;
  id?: string;
  phase?: string | null;
  count?: number;
  total?: number;
  imported?: number;
  error?: string | null;
  scheduled_for?: string | null;
  dailyCap: number;
  batches?: { id: string; status: string; scheduled_for: string | null }[];
  plan?: { total: number; importedSoFar: number; remaining: number; exceedsCap: boolean; dailyCap: number };
}

const PHASE_LABEL: Record<string, string> = { visiting: "Visiting profiles", enriching: "Working out profile addresses" };

export interface ImportBanner {
  tone: "info" | "bad";
  title: string;
  body: string;
  /** Contacts read so far against the size of the search, while a batch runs. */
  progress: { value: number; max: number } | null;
  /** The batch that can be cancelled, when one is running or queued. */
  cancel: string | null;
}

/** The strip above a list while it is being imported, or after its last batch failed. Null when there is nothing to say. */
export function importBanner(status: ImportStatus | undefined, now: Date = new Date()): ImportBanner | null {
  if (!status || status.status === "idle") return null;
  if (status.status === "running") {
    const total = status.total ?? 0;
    const count = status.count ?? status.imported ?? 0;
    return {
      tone: "info", title: `${PHASE_LABEL[status.phase ?? ""] ?? "Reading the Sales Navigator search"}: ${formatCount(count)}${total > 0 ? ` of ${formatCount(total)}` : ""} so far`,
      body: "Contacts appear here as each page is read. You can leave this page; the import carries on.",
      progress: total > 0 ? { value: count, max: total } : null, cancel: status.id ?? null,
    };
  }
  if (status.status === "scheduled") {
    const today = now.toISOString().slice(0, 10);
    const later = status.scheduled_for && status.scheduled_for > today;
    return {
      tone: "info", title: later ? "The next batch of this import is queued" : "An import from Sales Navigator is queued",
      body: later ? `It starts on ${formatDate(`${status.scheduled_for}T12:00:00`, now)}, inside the daily cap.` : "It starts in turn with other imports, usually within a minute.",
      progress: null, cancel: status.id ?? null,
    };
  }
  if (status.status === "error" || status.status === "failed") {
    return { tone: "bad", title: "The last import stopped with an error", body: status.error ?? "No reason was recorded. Contacts imported before it stopped are still in the list.", progress: null, cancel: null };
  }
  return null;
}

/** "This search has 4,200 contacts, more than the 1,500 a day cap, so it is imported in batches over several days. 1,500 imported, 2,700 to go." */
export function planLine(status: ImportStatus | undefined): string | null {
  const plan = status?.plan;
  if (!plan || !plan.exceedsCap || plan.remaining <= 0) return null;
  // Once every batch is finished or cancelled, nothing more is coming: the rest is not "to go".
  if (!status.batches?.some((batch) => batch.status === "running" || batch.status === "scheduled")) return null;
  return `This search has ${contactsNoun(plan.total)}, more than the cap of ${formatCount(plan.dailyCap)} a day, so it is imported in batches over several days. ${formatCount(plan.importedSoFar)} imported, ${formatCount(plan.remaining)} to go.`;
}

/** "340 of 1,500 imported today" */
export const capLine = (today: number, cap: number) => `${formatCount(today)} of ${formatCount(cap)} imported today`;

// ── List detail ───────────────────────────────────────────────────────────────

const RUN_STATE: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "good" }, paused: { label: "Paused", tone: "warn" }, completed: { label: "Completed", tone: "neutral" },
  pending: { label: "Not started", tone: "neutral" }, failed: { label: "Stopped", tone: "bad" },
};
export const runState = (status: string) => RUN_STATE[status] ?? { label: status, tone: "neutral" as Tone };

/** The five figures on a list's own page. */
export function detailKpis(detail: ListDetail): Kpi[] {
  const { list } = detail;
  const of = (part: number) => (list.contacts > 0 ? formatPercent(part / list.contacts, 0) : "—");
  return [
    { label: "Contacts", value: formatCount(list.contacts), note: list.enrichable > 0 ? `${formatCount(list.enrichable)} can be looked up on Apollo` : "None waiting for a look-up" },
    { label: "With an email", value: of(list.with_email), note: `${formatCount(list.with_email)} of ${formatCount(list.contacts)}` },
    {
      label: "Verified", value: list.with_email > 0 ? of(list.valid) : "—",
      note: list.with_email === 0 ? "No email addresses" : `${formatCount(list.valid)} valid · ${formatCount(list.risky)} risky${list.invalid ? ` · ${formatCount(list.invalid)} invalid` : ""}`,
      noteTone: list.risky + list.invalid > 0 ? "warn" : undefined,
    },
    { label: "Connected on LinkedIn", value: of(detail.connected), note: `${formatCount(detail.connected)} of ${formatCount(list.contacts)}` },
    { label: "In a campaign now", value: formatCount(detail.in_campaign), note: detail.replied > 0 ? `${formatCount(detail.replied)} have replied` : "No replies yet" },
  ];
}
