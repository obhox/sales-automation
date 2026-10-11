// The integrations Linki can connect to, and what the screen says about each. No React
// here, so the wording can be tested on its own.
import { formatRelative, plural } from "@/lib/client/format";
import type { ConnectionProvider, ConnectionRow } from "@/pages/api/platform/connections";

export type { ConnectionProvider, ConnectionRow };

export const KEYS_PATH = "/api/integrations";
export const CONNECTIONS_PATH = "/api/platform/connections";

/** A provider key as the keys route lists it: never the key, only its last four characters. */
export interface ProviderKey {
  key: string;
  configured: boolean;
  api_key_masked: string | null;
  updated_at: string;
}

export type IntegrationId = "apollo" | "openrouter" | "firecrawl" | "tinyfish" | ConnectionProvider;
export type IntegrationIcon = "rocket" | "brain" | "hexagon" | "cloud" | "calendar" | "calendar-days" | "rss" | "globe" | "bot";

export interface Setting {
  /** The name of the setting in the connection's config. */
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  required: boolean;
}

export interface Integration {
  id: IntegrationId;
  name: string;
  icon: IntegrationIcon;
  /** A provider key is one secret per workspace. A connection has a token, settings and a sync, and there can be several. */
  kind: "key" | "connection";
  group: "Data and AI" | "CRM" | "Calendars";
  /** A few words for the summary line: "Enrichment", "Two-way contact sync". */
  purpose: string;
  /** What connecting it does, in a sentence or two. */
  about: string;
  /** What the secret is called and where to get one. Null: this one needs no secret. */
  secret: { label: string; placeholder: string; hint: string } | null;
  settings: Setting[];
  /** What "Sync now" does. Null: there is nothing to sync. */
  sync: string | null;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "apollo", name: "Apollo", icon: "rocket", kind: "key", group: "Data and AI", purpose: "Enrichment",
    about: "Finds work emails and company details for the contacts in a list. Each lookup uses Apollo credits from your own account.",
    secret: { label: "API key", placeholder: "Paste your Apollo API key", hint: "In Apollo: Settings, then Integrations, then API. The key is stored encrypted and is not shown again." },
    settings: [], sync: null,
  },
  {
    id: "openrouter", name: "OpenRouter", icon: "brain", kind: "key", group: "Data and AI", purpose: "AI models",
    about: "Writes and classifies messages with the models you choose. Requests are billed to your own OpenRouter account.",
    secret: { label: "API key", placeholder: "sk-or-v1-…", hint: "From openrouter.ai, under Keys. The key is stored encrypted and is not shown again." },
    settings: [], sync: null,
  },
  {
    id: "firecrawl", name: "Firecrawl", icon: "globe", kind: "key", group: "Data and AI", purpose: "Web research",
    about: "Reads a company's own website \u2014 its home page, careers page, pricing \u2014 so a campaign can refer to something real. One credit a page, five when a page is read into fields, billed to your own Firecrawl account.",
    secret: { label: "API key", placeholder: "fc-\u2026", hint: "From firecrawl.dev, under API Keys. The key is stored encrypted and is not shown again." },
    settings: [], sync: null,
  },
  {
    id: "tinyfish", name: "TinyFish", icon: "bot", kind: "key", group: "Data and AI", purpose: "Web research",
    about: "For pages a reader cannot reach: a job board behind a search box, a listing behind filters. Its agent works the page to get there, and is charged per step from your own TinyFish wallet, so Linki caps every run.",
    secret: { label: "API key", placeholder: "Paste your TinyFish API key", hint: "From agent.tinyfish.ai, under API keys. The key is stored encrypted and is not shown again." },
    settings: [], sync: null,
  },
  {
    id: "hubspot", name: "HubSpot", icon: "hexagon", kind: "connection", group: "CRM", purpose: "Two-way contact sync",
    about: "Sends your contacts to HubSpot, matched by email address, and brings HubSpot's contacts in.",
    secret: { label: "Private app access token", placeholder: "pat-…", hint: "From a HubSpot private app that can read and write contacts. Stored encrypted and not shown again." },
    settings: [], sync: "Sends contacts with an email address to HubSpot and brings its contacts in.",
  },
  {
    id: "salesforce", name: "Salesforce", icon: "cloud", kind: "connection", group: "CRM", purpose: "Two-way contact sync",
    about: "Sends your contacts to Salesforce as Contact records, matched on an External ID field you choose.",
    secret: { label: "Access token", placeholder: "Paste an access token", hint: "A token for a user who can edit Contacts. Stored encrypted and not shown again." },
    settings: [
      { key: "instance_url", label: "Instance URL", placeholder: "https://yourcompany.my.salesforce.com", hint: "The address you sign in to Salesforce at.", required: true },
      { key: "external_id_field", label: "External ID field", placeholder: "Linki_Email__c", hint: "A field on Contact marked as an External ID. Contacts are matched on it by email address.", required: true },
      { key: "api_version", label: "API version", placeholder: "v67.0", hint: "Leave empty to use v67.0.", required: false },
    ],
    sync: "Sends contacts with an email address to Salesforce.",
  },
  {
    id: "google_calendar", name: "Google Calendar", icon: "calendar", kind: "connection", group: "Calendars", purpose: "Meetings",
    about: "Reads meetings from a Google calendar and files each one on the contact who was invited.",
    secret: { label: "Access token", placeholder: "Paste an access token", hint: "A token that can read the calendar's events. Stored encrypted and not shown again." },
    settings: [{ key: "calendar_id", label: "Calendar", placeholder: "primary", hint: "The calendar's id, or leave empty for the account's main calendar.", required: false }],
    sync: "Reads the calendar's meetings from the last 30 days and the year ahead.",
  },
  {
    id: "microsoft_calendar", name: "Microsoft Calendar", icon: "calendar-days", kind: "connection", group: "Calendars", purpose: "Meetings",
    about: "Reads meetings from an Outlook or Microsoft 365 calendar and files each one on the contact who was invited.",
    secret: { label: "Access token", placeholder: "Paste a Microsoft Graph access token", hint: "A Microsoft Graph token that can read the calendar. Stored encrypted and not shown again." },
    settings: [], sync: "Reads the calendar's meetings from the last 30 days and the year ahead.",
  },
  {
    id: "ical", name: "Calendar feed", icon: "rss", kind: "connection", group: "Calendars", purpose: "Meetings",
    about: "Reads meetings from any calendar that publishes an iCal address, and files each one on the contact who was invited.",
    secret: null,
    settings: [{ key: "url", label: "Feed address", placeholder: "https://calendar.example.com/your-calendar.ics", hint: "Treat a private address like a password: after saving, only its host is shown.", required: true }],
    sync: "Reads every meeting in the feed.",
  },
];

export const INTEGRATION: Record<IntegrationId, Integration> = Object.fromEntries(INTEGRATIONS.map((integration) => [integration.id, integration])) as Record<IntegrationId, Integration>;

export function connectionSettings(row: Pick<ConnectionRow, "config_json">): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(row.config_json || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

export type ConnectionState = "connected" | "failing" | "paused" | "waiting";

export function connectionState(row: Pick<ConnectionRow, "enabled" | "sync_error" | "last_synced_at">): ConnectionState {
  if (!row.enabled) return "paused";
  if (row.sync_error) return "failing";
  return row.last_synced_at ? "connected" : "waiting";
}

export const STATE: Record<ConnectionState, { label: string; tone: "good" | "bad" | "neutral" | "warn" }> = {
  connected: { label: "Connected", tone: "good" },
  failing: { label: "Sync failing", tone: "bad" },
  paused: { label: "Paused", tone: "neutral" },
  waiting: { label: "Not synced yet", tone: "warn" },
};

/** One line about a connection: when it last synced, or why it is not syncing. */
export function connectionLine(row: Pick<ConnectionRow, "enabled" | "sync_error" | "last_synced_at">, now: Date = new Date()): string {
  const state = connectionState(row);
  if (state === "paused") return row.last_synced_at ? `Paused · last synced ${formatRelative(row.last_synced_at, now)}` : "Paused · never synced";
  if (state === "failing") return row.last_synced_at ? `Last synced ${formatRelative(row.last_synced_at, now)} · the latest sync failed` : "The first sync failed";
  if (state === "waiting") return "Syncs within 15 minutes, or now if you ask";
  return `Synced ${formatRelative(row.last_synced_at, now)}`;
}

export interface IntegrationStatus {
  integration: Integration;
  connected: boolean;
  /** Its connections, for one that syncs. Empty for a provider key. */
  connections: ConnectionRow[];
  /** The key's last four characters, for a provider key that is saved. */
  key: ProviderKey | null;
  /** Something is wrong with at least one connection. */
  failing: boolean;
  /** The line under the name. */
  line: string;
}

/**
 * Where each integration stands. `extra` adds a fact only another screen knows (this
 * month's AI spend) to the line of the integration it belongs to.
 */
export function integrationStatuses(keys: ProviderKey[], connections: ConnectionRow[], now: Date = new Date(), extra: Partial<Record<IntegrationId, string>> = {}): IntegrationStatus[] {
  return INTEGRATIONS.map((integration) => {
    if (integration.kind === "key") {
      const key = keys.find((row) => row.key === integration.id && row.configured) ?? null;
      const detail = extra[integration.id] ?? (key?.api_key_masked ? `key ending ${key.api_key_masked.slice(-4)}` : null);
      return { integration, connected: Boolean(key), connections: [], key, failing: false, line: key && detail ? `${integration.purpose} · ${detail}` : integration.purpose };
    }
    const own = connections.filter((row) => row.provider === integration.id);
    const failing = own.some((row) => connectionState(row) === "failing");
    let line = integration.purpose;
    if (own.length === 1) line = `${integration.purpose} · ${lowerFirst(connectionLine(own[0], now))}`;
    else if (own.length > 1) line = `${integration.purpose} · ${own.length} connections${failing ? ", one failing" : ""}`;
    return { integration, connected: own.length > 0, connections: own, key: null, failing, line };
  });
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** "4 connected · 3 available". */
export function integrationSummary(statuses: IntegrationStatus[]): string {
  const connected = statuses.filter((status) => status.connected).length;
  const available = statuses.length - connected;
  return `${connected} connected · ${available} available`;
}

/** What a sync reported, as a sentence for the toast: {contacts_exported: 12, contacts_imported: 3} → "12 contacts sent, 3 brought in". */
export function syncResult(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const count = (key: string) => (typeof result[key] === "number" ? (result[key] as number) : null);
  const exported = count("contacts_exported");
  const imported = count("contacts_imported");
  const meetings = count("meetings_imported");
  if (exported !== null) parts.push(`${exported} ${plural(exported, "contact", "contacts")} sent`);
  if (imported !== null) parts.push(`${imported} brought in`);
  if (meetings !== null) parts.push(`${meetings} ${plural(meetings, "meeting", "meetings")} read`);
  return parts.length > 0 ? parts.join(", ") : "Sync finished";
}

/** The settings a connect form holds, checked before it is sent. Returns the field in error, if any. */
export function settingsProblem(integration: Integration, values: Record<string, string>, secret: string, editing: boolean): { field: string; message: string } | null {
  if (integration.secret && !editing && !secret.trim()) return { field: "secret", message: `Enter the ${integration.secret.label.toLowerCase()}.` };
  for (const setting of integration.settings) {
    const value = (values[setting.key] ?? "").trim();
    // A saved feed address comes back as its host only; left untouched, it is not sent and need not be valid.
    if (!value) {
      if (setting.required && !(editing && setting.key === "url")) return { field: setting.key, message: `Enter the ${setting.label.toLowerCase()}.` };
      continue;
    }
    if ((setting.key === "instance_url" || setting.key === "url") && !/^https:\/\/[^\s/]+/.test(value)) return { field: setting.key, message: "This should be an address starting with https://" };
  }
  return null;
}
