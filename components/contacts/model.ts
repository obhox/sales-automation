// What the Contacts screen knows about a contact, and how it words it. No React in here,
// so the wording can be tested.
import type { ContactFacets, ContactRow, ContactTag } from "@/lib/contacts/table";
import type { LinkedinStatus } from "@/lib/contacts/filters";
import type { TableSort, TableState } from "@/lib/client/table-state";
import { formatAge, formatCount, plural } from "@/lib/client/format";
import type { PickerOption, TableDensity, Tone } from "@/components/ui";

export type { ContactFacets, ContactRow, ContactTag, LinkedinStatus };

export const CONTACTS_PATH = "/api/targets";
export const CONTACT_TAGS_PATH = "/api/targets/tags";
export const ENRICH_PATH = "/api/targets/enrich";
export const CUSTOM_FIELDS_PATH = "/api/platform/custom-fields";
export const SAVED_VIEWS_PATH = "/api/platform/saved-views";
export const CONTACTS_EXPORT_PATH = "/api/export/contacts";
export const LISTS_PATH = "/api/lists";

export interface ContactsPage {
  items: ContactRow[];
  total: number;
  page: number;
  limit: number;
}

// ── Filters ───────────────────────────────────────────────────────────────────

/** Every filter the screen has, at its "no filter" value. The names are the API's. */
export const FILTER_DEFAULTS = {
  list_id: "all", email: "all", linkedin: "all", campaign: "all", intent: "all", owner: "all",
  tag: "all", seniority: "all", country: "all", replied: "all", enriched: "all",
};
export type ContactFilters = typeof FILTER_DEFAULTS;
export type FilterKey = Exclude<keyof ContactFilters, "list_id">;

export const DEFAULT_SORT: TableSort = { key: "intent", direction: "desc" };
export const PAGE_SIZES = [25, 50, 100];
export const TABLE_OPTIONS = { pageSize: 50, sort: DEFAULT_SORT, filters: FILTER_DEFAULTS };

export interface FilterDef {
  key: FilterKey;
  name: string;
  /** What the chip says when the filter is off. */
  any: string;
  /** Always in the bar. The others arrive through "Add filter". */
  pinned: boolean;
}

export const FILTERS: FilterDef[] = [
  { key: "email", name: "Email", any: "Any", pinned: true },
  { key: "linkedin", name: "LinkedIn", any: "Any", pinned: true },
  { key: "campaign", name: "Campaign", any: "Any", pinned: true },
  { key: "intent", name: "Intent", any: "Any", pinned: true },
  { key: "owner", name: "Owner", any: "Anyone", pinned: true },
  { key: "tag", name: "Tag", any: "Any", pinned: false },
  { key: "seniority", name: "Seniority", any: "Any", pinned: false },
  { key: "country", name: "Country", any: "Any", pinned: false },
  { key: "replied", name: "Replied", any: "Any", pinned: false },
  { key: "enriched", name: "Enriched", any: "Any", pinned: false },
];

const EMAIL_OPTIONS: PickerOption[] = [
  { value: "any", label: "Has an email" },
  { value: "verified", label: "Verified", dot: "good" },
  { value: "checked", label: "Checked", dot: "good" },
  { value: "catchall", label: "Catch-all", dot: "warn" },
  { value: "unverified", label: "Inconclusive", dot: "neutral" },
  { value: "invalid", label: "Invalid", dot: "bad" },
  { value: "unchecked", label: "Not checked", dot: "neutral" },
  { value: "none", label: "No email", separated: true },
];

export const LINKEDIN_LABEL: Record<LinkedinStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "good" },
  invite_sent: { label: "Invite sent", tone: "li" },
  inmail_sent: { label: "InMail sent", tone: "li" },
  withdrawn: { label: "Invite withdrawn", tone: "warn" },
  not_connected: { label: "Not connected", tone: "neutral" },
};

const SENIORITY_LABEL: Record<string, string> = { c_suite: "C-suite", vp: "VP", owner: "Owner", founder: "Founder", partner: "Partner", head: "Head", director: "Director", manager: "Manager", senior: "Senior", entry: "Entry", intern: "Intern" };
export const seniorityLabel = (value: string) => SENIORITY_LABEL[value.toLowerCase()] ?? value;

const CAMPAIGN_STATUS: Record<string, string> = { running: "Running", paused: "Paused", completed: "Completed", pending: "Not started", failed: "Stopped", cancelled: "Stopped", canceled: "Stopped" };
export const campaignStatusLabel = (status: string | null) => (status ? CAMPAIGN_STATUS[status] ?? status : "Not started");
export const campaignTone = (status: string | null): Tone => (status === "running" ? "brand" : status === "paused" ? "warn" : "neutral");

/** The choices a filter offers, after its "no filter" choice. */
export function filterOptions(key: FilterKey, facets: ContactFacets | undefined): PickerOption[] {
  switch (key) {
    case "email":
      return EMAIL_OPTIONS;
    case "linkedin":
      return (Object.keys(LINKEDIN_LABEL) as LinkedinStatus[]).map((value) => ({ value, label: LINKEDIN_LABEL[value].label, dot: LINKEDIN_LABEL[value].tone }));
    case "campaign":
      return [
        { value: "any", label: "In a campaign" },
        { value: "none", label: "In no campaign" },
        ...(facets?.campaigns ?? []).map((campaign, index) => ({ value: campaign.id, label: campaign.name, aside: campaignStatusLabel(campaign.status), dot: campaignTone(campaign.status), separated: index === 0 })),
      ];
    case "intent":
      return [{ value: "40", label: "≥ 40" }, { value: "60", label: "≥ 60" }, { value: "80", label: "≥ 80" }];
    case "owner":
      return [{ value: "none", label: "No owner" }, ...(facets?.members ?? []).map((member, index) => ({ value: member.id, label: member.name, separated: index === 0 }))];
    case "tag":
      return [{ value: "none", label: "No tags" }, ...(facets?.tags ?? []).map((tag, index) => ({ value: tag.id, label: tag.name, aside: formatCount(tag.count), dot: tagTone(tag.color), separated: index === 0 }))];
    case "seniority":
      return (facets?.seniorities ?? []).map((value) => ({ value, label: seniorityLabel(value) }));
    case "country":
      return (facets?.countries ?? []).map((value) => ({ value, label: value }));
    case "replied":
      return [{ value: "yes", label: "Replied" }, { value: "no", label: "No reply" }];
    case "enriched":
      return [{ value: "yes", label: "Enriched" }, { value: "no", label: "Not enriched" }];
  }
}

/** What a chip shows for its current value. A value that is no longer offered (a deleted tag) says so. */
export function filterValueLabel(def: FilterDef, value: string, facets: ContactFacets | undefined): string {
  if (value === "all") return def.any;
  const option = filterOptions(def.key, facets).find((candidate) => candidate.value === value);
  if (option) return option.label;
  if (def.key === "intent") return `≥ ${value}`;
  return facets ? "No longer here" : "…";
}

export const activeFilterKeys = (filters: ContactFilters): FilterKey[] => FILTERS.map((def) => def.key).filter((key) => filters[key] !== "all");

// ── Columns ───────────────────────────────────────────────────────────────────

export type ColumnKey = "company" | "email" | "linkedin" | "list" | "campaign" | "intent" | "owner" | "tags" | "last_activity" | "location" | "phone" | "created";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  width: number;
  /** In the table until the member takes it out. */
  shown: boolean;
  sortKey?: string;
}

/** In the order they sit in the table. The contact's name is always first and is not on this list. */
export const COLUMNS: ColumnDef[] = [
  { key: "company", label: "Company", width: 130, shown: true, sortKey: "company" },
  { key: "email", label: "Email", width: 190, shown: true, sortKey: "email" },
  { key: "linkedin", label: "LinkedIn", width: 112, shown: true },
  { key: "list", label: "List", width: 120, shown: true },
  { key: "campaign", label: "Campaign", width: 140, shown: true },
  { key: "intent", label: "Intent", width: 80, shown: true, sortKey: "intent" },
  { key: "owner", label: "Owner", width: 132, shown: false },
  { key: "tags", label: "Tags", width: 140, shown: false },
  { key: "last_activity", label: "Last activity", width: 96, shown: true, sortKey: "last_activity" },
  { key: "location", label: "Location", width: 150, shown: false },
  { key: "phone", label: "Phone", width: 130, shown: false },
  { key: "created", label: "Added", width: 88, shown: false, sortKey: "created" },
];
export const DEFAULT_COLUMNS: ColumnKey[] = COLUMNS.filter((column) => column.shown).map((column) => column.key);
/** The name column's own width: it takes what is left, but never less than this. */
export const NAME_COLUMN_MIN = 200;

export const DENSITIES: { value: TableDensity; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "regular", label: "Regular" },
  { value: "compact", label: "Compact" },
];

const isColumnKey = (value: unknown): value is ColumnKey => COLUMNS.some((column) => column.key === value);
const isDensity = (value: unknown): value is TableDensity => DENSITIES.some((density) => density.value === value);

/** How the member has the table set out: kept in the browser, and saved with a view. */
export interface TableLayout {
  columns: ColumnKey[];
  density: TableDensity;
}
export const DEFAULT_LAYOUT: TableLayout = { columns: DEFAULT_COLUMNS, density: "regular" };

/** Read a layout from stored JSON, dropping anything this version does not know. */
export function readLayout(stored: unknown): TableLayout {
  const value = (stored && typeof stored === "object" ? stored : {}) as { columns?: unknown; density?: unknown };
  const columns = Array.isArray(value.columns) ? value.columns.filter(isColumnKey) : DEFAULT_COLUMNS;
  return { columns: COLUMNS.map((column) => column.key).filter((key) => columns.includes(key)), density: isDensity(value.density) ? value.density : "regular" };
}

// ── Saved views ───────────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  editable: boolean;
  state: { query?: Record<string, string>; layout?: unknown };
}

/** The address-bar entries a view stores: everything but the page number. */
export function viewQuery(written: Record<string, string>): Record<string, string> {
  const { page: _page, ...rest } = written;
  void _page;
  return rest;
}

export function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? "") !== (b[key] ?? "")) return false;
  return true;
}

// ── Cells ─────────────────────────────────────────────────────────────────────

export type EmailKind = "verified" | "checked" | "catchall" | "invalid" | "unverified" | "unchecked";

/** How an email address's check reads: an icon kind, its tone, and a sentence for the tooltip. */
export function emailState(status: string | null): { kind: EmailKind; tone: Tone; title: string } {
  switch (status) {
    case "verified":
      return { kind: "verified", tone: "good", title: "Verified: the mailbox was confirmed to exist" };
    case "checked":
      return { kind: "checked", tone: "good", title: "Checked: the domain accepts mail; the mailbox itself was not probed" };
    case "catchall":
      return { kind: "catchall", tone: "warn", title: "Catch-all domain: it accepts any address, so delivery proves nothing" };
    case "invalid":
      return { kind: "invalid", tone: "bad", title: "Invalid: this address is not sent to" };
    case "unverified":
      return { kind: "unverified", tone: "neutral", title: "Inconclusive: the check could not reach an answer" };
    default:
      return { kind: "unchecked", tone: "neutral", title: "Not checked yet" };
  }
}

/** 0 to 100. High scores are green, middling amber, low grey, as the design draws them. */
export function intentTone(score: number): Tone {
  return score >= 70 ? "good" : score >= 40 ? "warn" : "neutral";
}

/** "2m ago", "3h ago", "Yesterday", "Oct 8". A dash when nothing has happened yet. */
export function lastActivityLabel(value: string | null, now: Date = new Date()): string {
  if (!value) return "—";
  const age = formatAge(value, now);
  if (age === "now") return "Just now";
  return /^\d+[mh]$/.test(age) ? `${age} ago` : age;
}

const TAG_TONES: Tone[] = ["neutral", "brand", "good", "warn", "bad", "li", "mail"];
export const TAG_COLORS = TAG_TONES;
export const tagTone = (color: string): Tone => (TAG_TONES.includes(color as Tone) ? (color as Tone) : "neutral");
export const TAG_COLOR_NAME: Record<Tone, string> = { neutral: "Grey", brand: "Indigo", good: "Green", warn: "Amber", bad: "Red", li: "Blue", mail: "Teal" };

/** "Enterprise EU" or "Enterprise EU +2". */
export function listsSummary(lists: { name: string }[]): { first: string; more: number } | null {
  return lists.length ? { first: lists[0].name, more: lists.length - 1 } : null;
}

// ── Selection and bulk actions ────────────────────────────────────────────────

export const contactsNoun = (count: number) => `${formatCount(count)} ${plural(count, "contact", "contacts")}`;

/** The line under the page that says what is showing: "Showing 1–16 of 148 contacts". */
export function rangeLine(page: number, pageSize: number, shown: number, total: number): string {
  if (total === 0) return "No contacts";
  const first = (page - 1) * pageSize + 1;
  return `Showing ${formatCount(first)}–${formatCount(first + shown - 1)} of ${contactsNoun(total)}`;
}

export interface EnrichPreview {
  apollo_connected: boolean;
  selected: number;
  eligible: number;
  eligible_ids: string[];
  tried_before: number;
  have_email: number;
  no_profile_address: number;
  credits: number;
  batch: number;
}

/** Why some of a selection will not be looked up, one line each. */
export function enrichSkips(preview: EnrichPreview): string[] {
  const lines: string[] = [];
  if (preview.have_email) lines.push(`${contactsNoun(preview.have_email)} already ${plural(preview.have_email, "has", "have")} an email address`);
  if (preview.no_profile_address) lines.push(`${contactsNoun(preview.no_profile_address)} ${plural(preview.no_profile_address, "has", "have")} no LinkedIn address to look up`);
  return lines;
}

export interface EnrichProgress {
  total: number;
  done: number;
  enriched: number;
  emails: number;
  notFound: number;
  failed: number;
  state: "running" | "stopping" | "finished" | "stopped" | "failed";
  error?: string;
}

/** What a finished or stopped run says. */
export function enrichOutcome(progress: EnrichProgress): string {
  const parts = [`${formatCount(progress.emails)} ${plural(progress.emails, "email", "emails")} found`];
  if (progress.notFound) parts.push(`${formatCount(progress.notFound)} not on Apollo`);
  if (progress.failed) parts.push(`${formatCount(progress.failed)} could not be looked up`);
  const lead = progress.state === "stopped" ? `Stopped after ${formatCount(progress.done)} of ${formatCount(progress.total)}` : `Looked up ${contactsNoun(progress.done)}`;
  return `${lead}: ${parts.join(", ")}`;
}

/** Cut ids into the batches the enrich route takes. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** What adding a selection to a campaign came back with, as a sentence. */
export function enrolOutcome(result: { enrolled: number; skipped_already_enrolled: number; skipped_active_elsewhere: number }, campaign: string): string {
  const parts = [`${contactsNoun(result.enrolled)} added to ${campaign}`];
  if (result.skipped_already_enrolled) parts.push(`${formatCount(result.skipped_already_enrolled)} already in it`);
  if (result.skipped_active_elsewhere) parts.push(`${formatCount(result.skipped_active_elsewhere)} still active in another campaign`);
  return parts.join(" · ");
}

/** The custom field key a name suggests: "Renewal date" → "renewal_date". */
export function fieldKeyFor(name: string): string {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(key) ? key : key ? `field_${key}` : "";
}

export const FIELD_TYPE_LABEL: Record<string, string> = { text: "Text", number: "Number", boolean: "Yes / no", date: "Date" };

/** The table state as a view stores it and as the profile page reads it back. */
export type ContactsTableState = TableState<ContactFilters>;
