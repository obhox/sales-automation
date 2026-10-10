// The browser settings a LinkedIn session runs under.
//
// LinkedIn ties a session to the browser it was created in. If the same cookies later
// arrive from a browser that looks different (another user agent, time zone or network
// address) it ends the session. So the settings a session was created with are recorded
// at sign-in and replayed exactly every time that session is used, and a change (a new
// proxy, say) only takes effect at the next sign-in.
//
// Accounts signed in before this was recorded have nothing stored. They ran, and keep
// running, on BUILT_IN, which is what every account used until now.
//
// This file has no browser and no database in it, so it can be tested directly.

export interface SessionProxy {
  /** Scheme, host and port: "http://proxy.example.com:8080". Never contains credentials. */
  server: string;
  username?: string;
  /** Encrypted with lib/crypto, as the account row stores it. */
  password?: string;
}

export interface SessionContextRecord {
  viewport: { width: number; height: number };
  userAgent: string;
  locale: string;
  timezoneId: string;
  proxy?: SessionProxy | null;
}

export const BUILT_IN: SessionContextRecord = {
  viewport: { width: 1920, height: 1080 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/New_York",
  proxy: null,
};

export interface ProxySettings {
  proxy_url?: string | null;
  proxy_username?: string | null;
  proxy_password?: string | null;
  timezone?: string | null;
}

const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:"]);

/** Why this proxy address cannot be used, or null when it can. */
export function proxyProblem(url: string, username?: string | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The proxy address must look like http://host:port";
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) return "The proxy address must start with http://, https:// or socks5://";
  if (!parsed.hostname) return "The proxy address needs a host";
  if (parsed.username || parsed.password) return "Put the proxy user name and password in their own fields, not in the address";
  if (parsed.pathname !== "/" && parsed.pathname !== "") return "The proxy address must not have a path";
  // Chromium cannot sign in to a SOCKS proxy; a SOCKS proxy has to be open to this server's address.
  if (parsed.protocol === "socks5:" && username) return "A SOCKS5 proxy cannot take a user name and password here. Use an HTTP proxy, or allow this server's address at the provider";
  return null;
}

/** The proxy address as stored: scheme, host and port, nothing else. */
export function normaliseProxyUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * The settings a new sign-in for this account will be created with: the built-in
 * browser, plus the account's proxy when it has one. With a proxy the browser's time
 * zone follows the account's, so the clock and the network address agree about where
 * the member is.
 */
export function contextForNewSession(account: ProxySettings): SessionContextRecord {
  if (!account.proxy_url) return { ...BUILT_IN };
  return {
    ...BUILT_IN,
    timezoneId: account.timezone || BUILT_IN.timezoneId,
    proxy: {
      server: account.proxy_url,
      ...(account.proxy_username ? { username: account.proxy_username } : {}),
      ...(account.proxy_password ? { password: account.proxy_password } : {}),
    },
  };
}

/** The settings an existing session was created with. Anything missing or unreadable means the built-in ones. */
export function storedContext(json: string | null | undefined): SessionContextRecord {
  if (!json) return { ...BUILT_IN };
  try {
    const parsed = JSON.parse(json) as Partial<SessionContextRecord>;
    if (!parsed || typeof parsed !== "object") return { ...BUILT_IN };
    const width = Number(parsed.viewport?.width);
    const height = Number(parsed.viewport?.height);
    return {
      viewport: width > 0 && height > 0 ? { width, height } : BUILT_IN.viewport,
      userAgent: typeof parsed.userAgent === "string" && parsed.userAgent ? parsed.userAgent : BUILT_IN.userAgent,
      locale: typeof parsed.locale === "string" && parsed.locale ? parsed.locale : BUILT_IN.locale,
      timezoneId: typeof parsed.timezoneId === "string" && parsed.timezoneId ? parsed.timezoneId : BUILT_IN.timezoneId,
      proxy: parsed.proxy && typeof parsed.proxy.server === "string" && parsed.proxy.server ? parsed.proxy : null,
    };
  } catch {
    return { ...BUILT_IN };
  }
}

export interface PlaywrightContextOptions {
  storageState?: object;
  viewport: { width: number; height: number };
  userAgent: string;
  locale: string;
  timezoneId: string;
  permissions: ("clipboard-read" | "clipboard-write")[];
  proxy?: { server: string; username?: string; password?: string };
}

/**
 * Turn a record into what the browser is given. `decrypt` opens the stored proxy
 * password. A proxy in the record is always used: there is no falling back to a direct
 * connection when it fails.
 */
export function playwrightOptions(record: SessionContextRecord, storageState: object | undefined, decrypt: (value: string) => string | null): PlaywrightContextOptions {
  const options: PlaywrightContextOptions = {
    storageState,
    viewport: record.viewport,
    userAgent: record.userAgent,
    locale: record.locale,
    timezoneId: record.timezoneId,
    permissions: ["clipboard-read", "clipboard-write"],
  };
  if (record.proxy) {
    const password = record.proxy.password ? decrypt(record.proxy.password) ?? undefined : undefined;
    options.proxy = { server: record.proxy.server, ...(record.proxy.username ? { username: record.proxy.username } : {}), ...(password ? { password } : {}) };
  }
  return options;
}
