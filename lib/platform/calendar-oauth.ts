// Connecting a Google or Microsoft calendar by signing in to it, rather than by pasting a
// token. The connection is an ordinary external_connections row, so the sync that reads a
// calendar (lib/platform/connectors.ts) is the same one either way; what this file adds is
// getting the token, and getting a new one when it runs out.
//
// The server needs an app registered with each provider (a client id and secret). Until it
// has one, `calendarOAuthAvailability` says so and nothing here can be started.
import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type DatabaseType from "better-sqlite3";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

type DB = DatabaseType.Database;

export const CALENDAR_OAUTH_PROVIDERS = ["google_calendar", "microsoft_calendar"] as const;
export type CalendarOAuthProvider = (typeof CALENDAR_OAUTH_PROVIDERS)[number];
export const isCalendarOAuthProvider = (value: unknown): value is CalendarOAuthProvider => (CALENDAR_OAUTH_PROVIDERS as readonly unknown[]).includes(value);

/** Something the person connecting can be told as it is. */
export class CalendarOAuthError extends Error {}

const PROVIDER = {
  google_calendar: {
    label: "Google Calendar",
    // The calendar's own app, or the one already registered for Gmail if it is to be shared.
    env: ["GOOGLE_CALENDAR", "GOOGLE_MAIL"],
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/calendar.events.readonly",
  },
  microsoft_calendar: {
    label: "Microsoft Calendar",
    env: ["MICROSOFT_CALENDAR", "MICROSOFT_MAIL"],
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid profile email offline_access Calendars.Read",
  },
} as const;

export const calendarProviderLabel = (provider: CalendarOAuthProvider) => PROVIDER[provider].label;

function client(provider: CalendarOAuthProvider): { id: string; secret: string } | null {
  for (const prefix of PROVIDER[provider].env) {
    const id = process.env[`${prefix}_CLIENT_ID`]?.trim();
    const secret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
    if (id && secret) return { id, secret };
  }
  return null;
}

/** Which providers this server can sign in to. */
export function calendarOAuthAvailability(): Record<CalendarOAuthProvider, boolean> {
  return { google_calendar: client("google_calendar") !== null, microsoft_calendar: client("microsoft_calendar") !== null };
}

/** The address the provider sends the person back to. It has to be registered with the provider's app, exactly. */
export const calendarRedirectUri = (origin: string, provider: CalendarOAuthProvider) => `${origin}/api/platform/calendar-oauth/${provider}/callback`;

// ── The `state` that goes out and comes back ────────────────────────────────────────────
// Signed rather than stored: it names the member, the workspace and the provider, and runs
// out after ten minutes. The callback also checks it against whoever is signed in, so a
// link made for one member cannot connect a calendar to another's workspace.
const STATE_TTL_MS = 10 * 60_000;

function stateKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET must be set to connect a calendar");
  return Buffer.from(hkdfSync("sha256", secret, "", "linki-calendar-oauth-state", 32));
}
const sign = (payload: string) => createHmac("sha256", stateKey()).update(payload).digest("base64url");

export interface CalendarOAuthState { workspaceId: string; userId: string; provider: CalendarOAuthProvider }

export function signCalendarState(state: CalendarOAuthState, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ w: state.workspaceId, u: state.userId, p: state.provider, e: now + STATE_TTL_MS, n: randomBytes(9).toString("base64url") })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The state that was signed, or null if it was not made here, has been changed, or has run out. */
export function readCalendarState(value: string, now: number = Date.now()): CalendarOAuthState | null {
  const [payload, signature, ...rest] = value.split(".");
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { w?: unknown; u?: unknown; p?: unknown; e?: unknown };
    if (typeof data.w !== "string" || typeof data.u !== "string" || !isCalendarOAuthProvider(data.p) || typeof data.e !== "number" || data.e < now) return null;
    return { workspaceId: data.w, userId: data.u, provider: data.p };
  } catch {
    return null;
  }
}

/** Where to send the member to sign in to their calendar. */
export function calendarAuthorizationUrl(input: CalendarOAuthState & { origin: string }): string {
  const app = client(input.provider);
  if (!app) throw new CalendarOAuthError(`${PROVIDER[input.provider].label} sign-in is not set up on this server`);
  const url = new URL(PROVIDER[input.provider].authorize);
  url.searchParams.set("client_id", app.id);
  url.searchParams.set("redirect_uri", calendarRedirectUri(input.origin, input.provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PROVIDER[input.provider].scope);
  url.searchParams.set("state", signCalendarState(input));
  if (input.provider === "google_calendar") {
    // Without these Google gives a token that lasts an hour and no way to get another.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("response_mode", "query");
  }
  return url.toString();
}

interface TokenAnswer { access: string; refresh: string | null; expiresAt: string; email: string | null }

async function tokenRequest(provider: CalendarOAuthProvider, fields: Record<string, string>): Promise<TokenAnswer> {
  const app = client(provider);
  if (!app) throw new CalendarOAuthError(`${PROVIDER[provider].label} sign-in is not set up on this server`);
  const body = new URLSearchParams({ client_id: app.id, client_secret: app.secret, ...fields });
  if (provider === "microsoft_calendar") body.set("scope", PROVIDER[provider].scope);
  let response: Response;
  try {
    response = await fetch(PROVIDER[provider].token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CalendarOAuthError(`${PROVIDER[provider].label} could not be reached`);
  }
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const access = typeof answer.access_token === "string" ? answer.access_token : "";
  if (!response.ok || !access) {
    const why = String(answer.error_description ?? answer.error ?? `answered ${response.status}`).split(/\r?\n/)[0].slice(0, 200);
    throw new CalendarOAuthError(`${PROVIDER[provider].label} did not accept the sign-in: ${why}`);
  }
  return {
    access,
    refresh: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : null,
    expiresAt: new Date(Date.now() + (Number(answer.expires_in) > 0 ? Number(answer.expires_in) : 3600) * 1000).toISOString(),
    email: emailFromIdToken(answer.id_token),
  };
}

/** The account's address, from the id token that came with the access token (straight from the provider, so it is read, not checked). */
function emailFromIdToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown; preferred_username?: unknown };
    const email = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
    return /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Finish a sign-in: swap the code for tokens and keep them as a calendar connection. Signing
 * in to the same account again renews its connection instead of making a second one.
 */
export async function completeCalendarOAuth(db: DB, input: CalendarOAuthState & { code: string; origin: string }): Promise<{ id: string; created: boolean; email: string | null }> {
  const token = await tokenRequest(input.provider, { grant_type: "authorization_code", code: input.code, redirect_uri: calendarRedirectUri(input.origin, input.provider) });
  const existing = token.email
    ? (db.prepare("SELECT id FROM external_connections WHERE workspace_id = ? AND provider = ? AND auth_method = 'oauth' AND lower(account_email) = ?")
        .get(input.workspaceId, input.provider, token.email) as { id: string } | undefined)
    : undefined;
  if (existing) {
    db.prepare(`UPDATE external_connections SET secret_value = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, enabled = 1, sync_error = NULL WHERE id = ?`)
      .run(encryptSecret(token.access), token.refresh ? encryptSecret(token.refresh) : null, token.expiresAt, existing.id);
    return { id: existing.id, created: false, email: token.email };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value, auth_method, refresh_token, token_expires_at, account_email, created_by)
    VALUES (?, ?, ?, ?, '{}', ?, 'oauth', ?, ?, ?, ?)`).run(
    id, input.workspaceId, input.provider, token.email ? `${PROVIDER[input.provider].label} (${token.email})` : PROVIDER[input.provider].label,
    encryptSecret(token.access), token.refresh ? encryptSecret(token.refresh) : null, token.expiresAt, token.email, input.userId,
  );
  return { id, created: true, email: token.email };
}

/**
 * The token to read a calendar with. A connection made by pasting a token gives that
 * token back. One made by signing in gets a new token first when its own is about to run
 * out, and says to sign in again when it cannot.
 */
export async function calendarAccessToken(db: DB, connection: { id: string; provider: string; secret_value: string | null; auth_method?: string | null; refresh_token?: string | null; token_expires_at?: string | null }): Promise<string | null> {
  const current = connection.secret_value ? decryptSecret(connection.secret_value) : null;
  if (connection.auth_method !== "oauth" || !isCalendarOAuthProvider(connection.provider)) return current;
  const expires = connection.token_expires_at ? Date.parse(connection.token_expires_at) : NaN;
  if (current && Number.isFinite(expires) && expires > Date.now() + 60_000) return current;
  const refresh = connection.refresh_token ? decryptSecret(connection.refresh_token) : null;
  if (!refresh) throw new CalendarOAuthError(`${PROVIDER[connection.provider].label} needs signing in to again`);
  const token = await tokenRequest(connection.provider, { grant_type: "refresh_token", refresh_token: refresh });
  db.prepare("UPDATE external_connections SET secret_value = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ? WHERE id = ?")
    .run(encryptSecret(token.access), token.refresh ? encryptSecret(token.refresh) : null, token.expiresAt, connection.id);
  return token.access;
}
