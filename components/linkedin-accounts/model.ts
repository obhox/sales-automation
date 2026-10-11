// What the LinkedIn accounts screen knows about an account, and how it words it. No
// React in here, so the wording can be tested.
import type { AccountStatus, LinkedinAccountView, LinkedinAccountsOverview } from "@/lib/linkedin/account-list";
import type { LinkedinPreset } from "@/lib/linkedin/account-settings";
import { formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";

export type { AccountStatus, LinkedinAccountView, LinkedinPreset };

export interface Member {
  id: string;
  name: string;
}

export type Overview = LinkedinAccountsOverview & { preset: LinkedinPreset; members: Member[] };

export const OVERVIEW_PATH = "/api/accounts?view=overview";

// ── Time ──────────────────────────────────────────────────────────────────────

/** 9 → "09:00". Hours run 0 to 24, where 24 is the end of the day. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export const HOURS = Array.from({ length: 25 }, (_, hour) => hour);

/** Monday first, as the account stores them (1 = Monday … 7 = Sunday). */
export const DAYS = [
  { value: 1, letter: "M", short: "Mon", name: "Monday" },
  { value: 2, letter: "T", short: "Tue", name: "Tuesday" },
  { value: 3, letter: "W", short: "Wed", name: "Wednesday" },
  { value: 4, letter: "T", short: "Thu", name: "Thursday" },
  { value: 5, letter: "F", short: "Fri", name: "Friday" },
  { value: 6, letter: "S", short: "Sat", name: "Saturday" },
  { value: 7, letter: "S", short: "Sun", name: "Sunday" },
] as const;

export function parseDays(days: string): number[] {
  return days.split(",").map((day) => Number(day.trim())).filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
}

/** "1,2,3,4,5" → "Mon–Fri"; "1,3,5" → "Mon, Wed, Fri". */
export function daysSummary(days: string): string {
  const on = parseDays(days);
  if (on.length === 0) return "no days";
  if (on.length === 7) return "every day";
  const consecutive = on.every((day, index) => index === 0 || day === on[index - 1] + 1);
  if (consecutive && on.length > 2) return `${DAYS[on[0] - 1].short}–${DAYS[on[on.length - 1] - 1].short}`;
  return on.map((day) => DAYS[day - 1].short).join(", ");
}

/** Seconds left as "4:18". Never negative. */
export function countdown(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface Badge {
  tone: Tone;
  label: string;
}

/** How the account signs in. Null until it has. */
export function methodBadge(account: LinkedinAccountView): Badge | null {
  if (account.session.method === "login") return { tone: "li", label: "Server login" };
  if (account.session.method === "cookie") return { tone: "neutral", label: "Cookie session" };
  return null;
}

export function sessionBadge(account: LinkedinAccountView): Badge {
  if (account.session.signed_in) return account.session.error ? { tone: "warn", label: "Proxy not answering" } : { tone: "good", label: "Session healthy" };
  if (account.status === "needs_signin") return { tone: "bad", label: "Sign-in needed" };
  if (account.status === "disconnected") return { tone: "bad", label: "Disconnected" };
  return { tone: "neutral", label: "Not connected" };
}

/** What the account is doing. Null when the session badge already says it all. */
export function statusBadge(account: LinkedinAccountView): Badge | null {
  switch (account.status) {
    case "active":
      return { tone: "good", label: "Active" };
    case "paused":
      return { tone: "warn", label: "Paused" };
    case "weekly_hold":
      return { tone: "warn", label: "Invitations on hold · weekly limit" };
    case "warming_up":
      return account.ramp ? { tone: "brand", label: `Warming up · day ${account.ramp.day} of ${account.ramp.days}` } : { tone: "brand", label: "Warming up" };
    default:
      return null;
  }
}

/** The small line at the right of a card's head: when it last heard from LinkedIn, or what went wrong. */
export function syncLine(account: LinkedinAccountView, now: Date = new Date()): { text: string; bad: boolean } {
  if (!account.session.signed_in) {
    if (account.status === "never_connected") return { text: "Not signed in yet", bad: false };
    const when = account.session.changed_at ? ` ${formatRelative(account.session.changed_at, now)}` : "";
    return account.status === "disconnected" ? { text: `Disconnected${when}`, bad: false } : { text: `Session ended${when}`, bad: true };
  }
  const latest = [account.synced.replies_at, account.synced.connections_at, account.synced.stats_at]
    .map((value) => parseTime(value))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return { text: latest ? `Synced ${formatRelative(latest, now)}` : "Not synced yet", bad: false };
}

/** "email · plan · Owner Name · Proxy label". */
export function metaLine(account: LinkedinAccountView): string {
  const parts = [account.email];
  if (account.plan) parts.push(account.plan);
  if (account.owner) parts.push(`Owner ${account.owner.name}`);
  if (account.proxy) parts.push(`Proxy ${account.proxy.label || hostOf(account.proxy.server)}`);
  return parts.join(" · ");
}

export function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

// ── Limits ────────────────────────────────────────────────────────────────────

export interface LimitMeter {
  key: "connections" | "messages" | "visits" | "withdrawals";
  label: string;
  used: number;
  limit: number;
  tone: Tone;
  note: string;
}

/** The four meters on a card. A meter turns amber at nine tenths of its limit. */
export function limitMeters(account: LinkedinAccountView): LimitMeter[] {
  const meter = (key: LimitMeter["key"], label: string, used: number, limit: number, note?: string): LimitMeter => {
    const left = Math.max(0, limit - used);
    return { key, label, used, limit, tone: limit > 0 && used >= limit * 0.9 ? "warn" : "li", note: note ?? `${left} left today · resets 00:00` };
  };
  const { usage, limits, weekly, ramp } = account;
  // Nothing runs on an account with no session, or on a paused one: say that, not what is "left".
  const idle = !account.session.signed_in ? "Signed out · nothing is running" : account.paused ? "Paused · nothing is running" : null;
  if (idle) {
    return [
      meter("connections", "Connections", usage.connects, limits.connections, idle),
      meter("messages", "Messages", usage.messages, limits.messages, idle),
      meter("visits", "Profile visits", usage.visits, limits.visits, idle),
      meter("withdrawals", "Withdrawals", usage.withdrawals, limits.withdrawals, idle),
    ];
  }
  let connectNote: string | undefined;
  if (weekly.hold?.reason === "cap") connectNote = `On hold · ${weekly.hold.used} of ${weekly.hold.limit} this week`;
  else if (weekly.hold?.reason === "linkedin") connectNote = "On hold · LinkedIn's weekly limit";
  else if (ramp) connectNote = `${Math.max(0, limits.connections - usage.connects)} left today · full limit ${limits.connections_full}`;
  else if (weekly.limit) connectNote = `${Math.max(0, limits.connections - usage.connects)} left today · ${weekly.used} of ${weekly.limit} this week`;
  return [
    meter("connections", "Connections", usage.connects, limits.connections, connectNote),
    meter("messages", "Messages", usage.messages, limits.messages),
    meter("visits", "Profile visits", usage.visits, limits.visits),
    meter("withdrawals", "Withdrawals", usage.withdrawals, limits.withdrawals, account.invites.stale.on_hold ? "On hold until tomorrow" : undefined),
  ];
}

// ── Things that need a person ─────────────────────────────────────────────────

export interface Attention {
  /** Stable for as long as the problem is the same one, so a dismissal sticks to it. */
  key: string;
  accountId: string;
  tone: "bad" | "warn";
  title: string;
  detail: string;
  action: "reconnect" | "edit" | "proxy";
}

/** One notice per account that needs someone, most pressing first. A paused account is somebody's decision, so it is not here. */
export function attentionFor(accounts: LinkedinAccountView[], now: Date = new Date()): Attention[] {
  const out: Attention[] = [];
  for (const account of accounts) {
    if (account.status === "needs_signin") {
      out.push({
        key: `signin:${account.id}:${account.session.changed_at ?? ""}`, accountId: account.id, tone: "bad", action: "reconnect",
        title: `${account.name} needs to sign in to LinkedIn again`,
        detail: `LinkedIn ended the session${account.session.changed_at ? ` ${formatRelative(account.session.changed_at, now)}` : ""} · this account's LinkedIn steps and reply reading wait until it is reconnected · email steps carry on`,
      });
    } else if (account.session.signed_in && account.session.error) {
      out.push({
        key: `proxy:${account.id}`, accountId: account.id, tone: "bad", action: "proxy",
        title: `The proxy for ${account.name} is not answering`,
        detail: "Nothing is sent without the proxy · this account's LinkedIn steps wait and one is tried again every half hour",
      });
    } else if (account.status === "weekly_hold" && account.weekly.hold) {
      const hold = account.weekly.hold;
      out.push({
        key: `weekly:${account.id}:${hold.reason}`, accountId: account.id, tone: "warn", action: "edit",
        title: `Weekly invitation limit reached on ${account.name}`,
        detail: hold.reason === "cap"
          ? `${hold.used} of ${hold.limit} invitations used in the last seven days · invitations start again as older ones pass seven days · messages and visits carry on`
          : `LinkedIn refused an invitation · one is tried again ${formatRelative(hold.until, now) === "just now" ? "shortly" : `on ${new Date(hold.until).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`} · messages and visits carry on`,
      });
    }
  }
  const rank = { reconnect: 0, proxy: 1, edit: 2 } as const;
  return out.sort((a, b) => rank[a.action] - rank[b.action]);
}

// ── The four figures across the top ───────────────────────────────────────────

export interface Totals {
  connected: number;
  total: number;
  healthyNote: string;
  healthyTone: "warn" | "muted";
  invitesToday: number;
  invitesCap: number;
  pending: number | null;
  waitingWithdrawal: number;
}

export function totals(accounts: LinkedinAccountView[]): Totals {
  const signedIn = accounts.filter((account) => account.session.signed_in);
  const needSignin = accounts.filter((account) => account.status === "needs_signin").length;
  const notConnected = accounts.filter((account) => account.status === "never_connected" || account.status === "disconnected").length;
  const paused = accounts.filter((account) => account.status === "paused").length;
  const healthy = signedIn.length - paused;
  const notes = [`${healthy} healthy`];
  if (paused) notes.push(`${paused} paused`);
  if (needSignin) notes.push(`${needSignin} ${plural(needSignin, "needs", "need")} sign-in`);
  if (notConnected) notes.push(`${notConnected} not connected`);
  const pendingKnown = signedIn.filter((account) => account.invites.pending !== null);
  return {
    connected: signedIn.length,
    total: accounts.length,
    healthyNote: accounts.length === 0 ? "None connected yet" : notes.join(" · "),
    healthyTone: needSignin > 0 ? "warn" : "muted",
    invitesToday: accounts.reduce((sum, account) => sum + account.usage.connects, 0),
    // Every signed-in account's limit for today, paused or not: a paused account's
    // invitations from earlier in the day are in the count, so its limit is in the cap.
    invitesCap: signedIn.reduce((sum, account) => sum + account.limits.connections, 0),
    pending: pendingKnown.length > 0 ? pendingKnown.reduce((sum, account) => sum + (account.invites.pending ?? 0), 0) : null,
    waitingWithdrawal: accounts.reduce((sum, account) => sum + account.invites.stale.waiting, 0),
  };
}

// ── The preset in words ───────────────────────────────────────────────────────

/** What a new account starts with, as the three lines under "Safety defaults". */
export function presetLines(preset: LinkedinPreset, timezone: string): string[] {
  const invites = preset.ramp_days && preset.ramp_start_limit
    ? `Starts at ${preset.ramp_start_limit} ${plural(preset.ramp_start_limit, "invitation", "invitations")} a day, rising to ${preset.daily_connection_limit} over ${preset.ramp_days} days`
    : `Up to ${preset.daily_connection_limit} invitations a day${preset.weekly_connection_limit ? ` and ${preset.weekly_connection_limit} in any seven days` : ""}`;
  const hours = `Works ${hourLabel(preset.active_hours_start)}–${hourLabel(preset.active_hours_end)}, ${daysSummary(preset.working_days)}, ${timezone}`;
  const withdraw = preset.withdraw_stale_invites
    ? `Takes back invitations left unanswered${preset.invite_max_wait_days ? ` for ${preset.invite_max_wait_days} days` : ""}`
    : "Leaves old invitations alone until you switch clean-up on";
  return [invites, hours, withdraw];
}
