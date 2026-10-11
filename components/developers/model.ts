// What the Developer API screen says, worked out from what the routes return. No React
// here, so the wording can be tested on its own.
import { formatCount, formatPercent, formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";
import type { InstanceHealth } from "@/lib/system/instance";
import type { ApiKeyRow } from "@/pages/api/platform/api-keys";
import type { McpInfo } from "@/pages/api/platform/mcp";
import type { DeadLetter, WebhookHealth, WebhookRow } from "@/pages/api/platform/webhooks";

export type { ApiKeyRow, DeadLetter, InstanceHealth, McpInfo, WebhookHealth, WebhookRow };

export const KEYS_PATH = "/api/platform/api-keys";
export const WEBHOOKS_PATH = "/api/platform/webhooks";
export const MCP_PATH = "/api/platform/mcp";
export const INSTANCE_PATH = "/api/platform/instance";

export const MAX_RATE_LIMIT = 10_000;

/** What a key may be allowed to do, in the order the dialog offers them. */
export const SCOPES: Array<{ scope: string; label: string; detail: string }> = [
  { scope: "contacts:read", label: "Read contacts", detail: "Contacts and the do-not-contact list" },
  { scope: "contacts:write", label: "Change contacts", detail: "Create and update contacts, verify their addresses" },
  { scope: "campaigns:read", label: "Read campaigns", detail: "Companies, lists, campaigns, runs and sent messages" },
  { scope: "campaigns:write", label: "Change campaigns", detail: "Kept for later: no endpoint asks for it yet" },
  { scope: "events:read", label: "Read events", detail: "Events, signals and signal rules" },
  { scope: "events:write", label: "Report events", detail: "Tell Linki of a reply, a bounce or a booked meeting" },
  { scope: "signals:write", label: "Send signals", detail: "Push a signal about a contact or a company" },
  { scope: "crm:read", label: "Read the pipeline", detail: "Opportunities and pipeline stages" },
  { scope: "crm:write", label: "Change the pipeline", detail: "Create and update opportunities" },
  { scope: "email:read", label: "Read mailboxes", detail: "Which addresses this workspace can send from, never their credentials" },
  { scope: "email:send", label: "Send email", detail: "Send one email to a contact from a mailbox" },
  { scope: "mcp:read", label: "MCP: read", detail: "Lets an MCP client use this key to read, acting as you with your role" },
  { scope: "mcp:write", label: "MCP: change", detail: "Lets an MCP client use this key to change things, acting as you with your role" },
  { scope: "mcp:execute", label: "MCP: run", detail: "Lets an MCP client use this key to start sends, syncs and other runs, acting as you" },
];

const DAY_MS = 86_400_000;

/** "lnk_8f2cAbCd••••": the part of a key that is kept, and a sign that the rest is not. */
export function maskedKey(prefix: string): string {
  return `${prefix}••••`;
}

export function scopeList(scopes: string): string[] {
  return scopes.split(/[\s,]+/).filter(Boolean);
}

/** The scopes there is room to show, and how many more there are. */
export function scopeChips(scopes: string, room = 2): { shown: string[]; more: number } {
  const all = scopeList(scopes);
  return { shown: all.slice(0, room), more: Math.max(0, all.length - room) };
}

export function isRevoked(key: Pick<ApiKeyRow, "revoked_at">): boolean {
  return Boolean(key.revoked_at);
}

export function isExpired(key: Pick<ApiKeyRow, "expires_at">, now: Date = new Date()): boolean {
  const expires = parseTime(key.expires_at);
  return expires !== null && expires.getTime() <= now.getTime();
}

/** A key that can still be used. */
export function isLive(key: Pick<ApiKeyRow, "revoked_at" | "expires_at">, now: Date = new Date()): boolean {
  return !isRevoked(key) && !isExpired(key, now);
}

const fullDate = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const shortDate = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The "Expires" cell: a date, and how far off it is. A key expiring within two weeks is marked. */
export function expiryCell(key: Pick<ApiKeyRow, "revoked_at" | "expires_at">, now: Date = new Date()): { date: string; note: string; tone: "neutral" | "warn" | "bad" } {
  const revoked = parseTime(key.revoked_at);
  if (revoked) return { date: `Revoked ${shortDate(revoked)}`, note: "No longer works", tone: "bad" };
  const expires = parseTime(key.expires_at);
  if (!expires) return { date: "Never", note: "No expiry set", tone: "neutral" };
  const days = Math.ceil((expires.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return { date: fullDate(expires), note: "Expired", tone: "bad" };
  return { date: fullDate(expires), note: days === 1 ? "in 1 day" : `in ${formatCount(days)} days`, tone: days <= 14 ? "warn" : "neutral" };
}

export function lastUsed(value: string | null, now: Date = new Date()): string {
  return value ? formatRelative(value, now) : "Never used";
}

/** "600 req / min", or what it means to have none. */
export function rateLimitLabel(limit: number | null): string {
  return limit ? `${formatCount(limit)} req / min` : "No rate limit";
}

/** The pill in the card's header: one line for the keys that work. */
export function rateLimitSummary(keys: ApiKeyRow[], now: Date = new Date()): string | null {
  const live = keys.filter((key) => isLive(key, now));
  if (live.length === 0) return null;
  const limits = new Set(live.map((key) => key.rate_limit_per_minute));
  if (limits.size === 1) return rateLimitLabel(live[0].rate_limit_per_minute);
  const limited = live.filter((key) => key.rate_limit_per_minute).length;
  return `${limited} of ${live.length} keys rate limited`;
}

/** A rate limit as typed in the dialog. `error` when it cannot be used. */
export function readRateLimit(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < 1 || value > MAX_RATE_LIMIT) return { value: null, error: `Enter a whole number from 1 to ${formatCount(MAX_RATE_LIMIT)}, or leave it empty for no limit.` };
  return { value, error: null };
}

export const EXPIRY_CHOICES = [
  { value: "never", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 1 year" },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"];

/** The moment a key made now would stop working, as the API takes it ("2026-11-09 10:00:00", UTC). */
export function expiryFor(choice: ExpiryChoice, now: Date = new Date()): string | undefined {
  if (choice === "never") return undefined;
  return new Date(now.getTime() + Number(choice) * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
}

// ── Webhooks ─────────────────────────────────────────────────────────

export function eventList(eventTypes: string): string[] {
  return eventTypes.split(",").map((type) => type.trim()).filter(Boolean);
}

/** The "Events" cell: the first event, and how many more. "*" is every event. */
export function eventChips(eventTypes: string): { first: string; more: string | null } {
  const events = eventList(eventTypes);
  if (events.length === 0 || events.includes("*")) return { first: "All events", more: null };
  const rest = events.length - 1;
  return { first: events[0], more: rest > 0 ? `+${rest} more ${plural(rest, "event", "events")}` : null };
}

export const HEALTH: Record<WebhookHealth, { label: string; tone: Tone; explain: string }> = {
  healthy: { label: "Healthy", tone: "good", explain: "Its latest delivery was accepted." },
  retrying: { label: "Retrying", tone: "bad", explain: "A delivery failed and is being tried again, with a longer wait each time." },
  failing: { label: "Failing", tone: "bad", explain: "Its latest delivery was given up on after eight attempts." },
  paused: { label: "Paused", tone: "neutral", explain: "Nothing is sent to it, and events that happen meanwhile are not kept for it." },
  idle: { label: "No deliveries", tone: "neutral", explain: "Nothing has been sent to it yet." },
};

/** The "Success" cell. Under 95% is marked, under 80% more so. */
export function successCell(hook: Pick<WebhookRow, "success_rate">): { label: string; tone: "good" | "warn" | "bad" | "neutral" } {
  if (hook.success_rate === null) return { label: "—", tone: "neutral" };
  // A whole number has no use for a decimal place: "100%" and "0%", but "99.8%".
  const label = hook.success_rate === 1 ? "100%" : hook.success_rate === 0 ? "0%" : formatPercent(hook.success_rate);
  return { label, tone: hook.success_rate >= 0.95 ? "good" : hook.success_rate >= 0.8 ? "warn" : "bad" };
}

/** The "Last delivery" cell: when, and that it failed if it did. */
export function lastDeliveryCell(hook: Pick<WebhookRow, "last_delivery_at" | "last_status">, now: Date = new Date()): { label: string; failed: boolean } {
  if (!hook.last_delivery_at) return { label: "—", failed: false };
  const failed = hook.last_status === "retrying" || hook.last_status === "dead_letter";
  const when = formatRelative(hook.last_delivery_at, now);
  return { label: failed ? `Failed ${when}` : when, failed };
}

export function hookName(hook: Pick<WebhookRow, "name" | "url">): string {
  if (hook.name) return hook.name;
  try {
    return new URL(hook.url).host;
  } catch {
    return hook.url;
  }
}

export function deadLetterTotal(hooks: WebhookRow[]): number {
  return hooks.reduce((sum, hook) => sum + hook.dead_letters, 0);
}

export interface Delivery {
  id: string;
  event_type: string;
  status: "pending" | "retrying" | "delivered" | "dead_letter" | string;
  attempt: number;
  response_status: number | null;
  last_error: string | null;
  response_body: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
}

export const DELIVERY_STATUS: Record<string, { label: string; tone: Tone }> = {
  delivered: { label: "Delivered", tone: "good" },
  pending: { label: "Waiting", tone: "neutral" },
  retrying: { label: "Retrying", tone: "warn" },
  dead_letter: { label: "Given up", tone: "bad" },
};

/** One line under a delivery: how the endpoint answered, or why it could not be reached. */
export function deliveryDetail(delivery: Pick<Delivery, "status" | "attempt" | "response_status" | "last_error" | "next_attempt_at">, now: Date = new Date()): string {
  const tries = `${delivery.attempt} ${plural(delivery.attempt, "attempt", "attempts")}`;
  if (delivery.status === "delivered") return `Answered ${delivery.response_status ?? 200} · ${tries}`;
  if (delivery.status === "pending") return "Not sent yet";
  const reason = delivery.last_error?.trim() || (delivery.response_status ? `Answered ${delivery.response_status}` : "No answer");
  if (delivery.status === "retrying") {
    const next = parseTime(delivery.next_attempt_at);
    const minutes = next ? Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000)) : null;
    return `${reason} · ${tries}${minutes ? ` · next in ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`}` : ""}`;
  }
  return `${reason} · ${tries}`;
}

// ── MCP ──────────────────────────────────────────────────────────────

/**
 * The ways to point a client at the server. `cli`, `json` and `opencode` sign in through the
 * browser, so none of them holds a key. `key` and `opencodeKey` are for a terminal or a machine
 * with no browser: they send an API key (with an mcp:* scope) as the bearer token instead.
 */
export function mcpSnippets(url: string): { cli: string; json: string; opencode: string; key: string; opencodeKey: string } {
  return {
    cli: `claude mcp add --transport http linki ${url}`,
    json: JSON.stringify({ mcpServers: { linki: { type: "http", url } } }, null, 2),
    opencode: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { linki: { type: "remote", url, enabled: true } } }, null, 2),
    key: `claude mcp add --transport http linki ${url} --header "Authorization: Bearer $LINKI_API_KEY"`,
    opencodeKey: JSON.stringify(
      { $schema: "https://opencode.ai/config.json", mcp: { linki: { type: "remote", url, enabled: true, oauth: false, headers: { Authorization: "Bearer {env:LINKI_API_KEY}" } } } },
      null,
      2,
    ),
  };
}

/** The groups there is room to show, and how many more there are. */
export function shownGroups<T>(groups: T[], room = 3): { shown: T[]; more: number } {
  return { shown: groups.slice(0, room), more: Math.max(0, groups.length - room) };
}

// ── Instance health ──────────────────────────────────────────────────

export type ServiceStatus = "healthy" | "degraded" | "off" | "idle";

export interface ServiceRow {
  key: string;
  name: string;
  meta: string;
  status: ServiceStatus;
  status_label: string;
}

export const SERVICE_TONE: Record<ServiceStatus, { dot: string; text: string }> = {
  healthy: { dot: "bg-good", text: "text-good" },
  degraded: { dot: "bg-warn", text: "text-warn" },
  off: { dot: "bg-ink-3", text: "text-ink-2" },
  idle: { dot: "bg-ink-3", text: "text-ink-2" },
};

/** 13_316_000_000 → "12.4 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !(bytes > 0)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Up 18 days", "Up 5 hours", "Up 12 min", "Just started". */
export function uptimeLabel(seconds: number): string {
  if (seconds < 60) return "Just started";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Up ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Up ${hours} ${plural(hours, "hour", "hours")}`;
  return `Up ${Math.floor(hours / 24)} days`;
}

const versionLabel = (version: string) => (/^\d/.test(version) ? `v${version}` : version);

function loopMeta(loop: InstanceHealth["loops"][number]): string {
  const since = loop.minutes_since <= 0 ? "Last pass just now" : `Last pass ${formatCount(loop.minutes_since)} min ago`;
  return loop.waiting === null || !loop.waiting_noun ? since : `${since} · ${formatCount(loop.waiting)} ${loop.waiting_noun}`;
}

/** The loops with a queue this workspace can fill are always shown; the others only when one is behind. */
const ALWAYS_SHOWN = new Set(["email-jobs-runner", "linkedin-runner", "webhook-runner"]);

/**
 * The rows of the health card. `all` shows every loop; otherwise the quiet ones that are
 * fine are folded into one row.
 */
export function serviceRows(health: InstanceHealth, all = false): ServiceRow[] {
  const rows: ServiceRow[] = [
    { key: "app", name: "Web app and API", meta: `${versionLabel(health.version)} · Node ${health.node.replace(/^v/, "")}`, status: "healthy", status_label: "Healthy" },
  ];
  if (health.status === "off") {
    rows.push({ key: "runners", name: "Background work", meta: "Switched off for this instance: nothing is sent or read", status: "off", status_label: "Off" });
  } else if (health.status === "idle") {
    rows.push({ key: "runners", name: "Background work", meta: "Starts with the first request that needs it", status: "idle", status_label: "Not started" });
  } else {
    const shown = health.loops.filter((loop) => all || loop.stalled || ALWAYS_SHOWN.has(loop.name));
    for (const loop of shown) {
      rows.push({ key: loop.name, name: loop.label, meta: loopMeta(loop), status: loop.stalled ? "degraded" : "healthy", status_label: loop.stalled ? "Stalled" : "Healthy" });
    }
    const folded = health.loops.length - shown.length;
    if (folded > 0) rows.push({ key: "others", name: `${folded} other ${plural(folded, "loop", "loops")}`, meta: "Warm-up, reply reading, imports and the rest", status: "healthy", status_label: "Healthy" });
  }
  const free = health.database.free_bytes;
  rows.push({ key: "database", name: "Database", meta: `SQLite · ${formatBytes(health.database.bytes)}${free ? ` · ${formatBytes(free)} free on its volume` : ""}`, status: "healthy", status_label: "Healthy" });
  return rows;
}

export function foldedLoops(health: InstanceHealth): number {
  if (health.status === "off" || health.status === "idle") return 0;
  return health.loops.filter((loop) => !loop.stalled && !ALWAYS_SHOWN.has(loop.name)).length;
}

/** The pill at the top of the health card. */
export function healthPill(health: InstanceHealth): { label: string; tone: Tone } {
  if (health.status === "degraded") return { label: health.summary, tone: "warn" };
  if (health.status === "off") return { label: "Background work off", tone: "neutral" };
  return { label: uptimeLabel(health.uptime_seconds), tone: "good" };
}

/** "Self-hosted · linki.acme.com · v2.4.1" beside the title. */
export function instanceContext(host: string, version: string): string {
  return ["Self-hosted", host, versionLabel(version)].filter(Boolean).join(" · ");
}
