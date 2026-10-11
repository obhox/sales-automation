import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import zlib from "zlib";

// Requests to an address a workspace chose: where a webhook is delivered, the calendar
// feed a connection reads, the Salesforce instance it syncs with. On an instance other
// people sign up to, such an address must not be allowed to point back inside: at this
// server, at the cloud provider's metadata service, or at anything on the private network
// the instance sits on. Otherwise it is a way to make the server fetch internal URLs, and
// a delivery log or a sync error a way to read what came back.
//
// An operator whose own receivers or calendar server live on a private network can allow
// them for the whole instance: WEBHOOK_ALLOW_PRIVATE_NETWORKS=true for webhooks,
// CONNECTIONS_ALLOW_PRIVATE_NETWORKS=true for CRM and calendar connections. Each is a
// deploy-time choice, never a workspace's.

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
];

function v4ToInt(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

/** True for loopback, private, link-local (which includes cloud metadata), carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const value = v4ToInt(address);
    return BLOCKED_V4.some(([base, bits]) => (value >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (!net.isIPv6(address)) return true; // not an address at all: nothing to connect to
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("::ffff:");
}

export function privateNetworksAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === "true";
}

/** The same choice for CRM and calendar connections. Its own setting, so allowing one does not quietly allow the other. */
export function connectionPrivateNetworksAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS === "true";
}

/** What a person is told when a connection's address is refused for where it is: at saving, and again if a sync finds it so. */
export const CONNECTION_ADDRESS_REFUSED = "That address is on a private or local network, which Linki does not connect to. Whoever runs this instance can allow it.";

type AddressFault = "malformed" | "protocol" | "credentials" | "private" | "not_found";

/** What is wrong with an address as somewhere to send a request, or null. Looks the name up, so it can take a moment. */
async function addressFault(url: string, options: { allowHttp: boolean; allowPrivate: boolean }): Promise<AddressFault | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "malformed"; }
  if (parsed.protocol !== "https:" && !(options.allowHttp && parsed.protocol === "http:")) return "protocol";
  if (parsed.username || parsed.password) return "credentials";
  if (options.allowPrivate) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return isPrivateAddress(host) ? "private" : null;
  try {
    const addresses = await dns.promises.lookup(host, { all: true });
    if (addresses.length === 0) return "not_found";
    return addresses.some((entry) => isPrivateAddress(entry.address)) ? "private" : null;
  } catch {
    return "not_found";
  }
}

/** Why this is not somewhere a webhook may be sent, or null when it is. Looks the name up, so it can take a moment. */
export async function webhookUrlProblem(url: string): Promise<string | null> {
  const fault = await addressFault(url, { allowHttp: false, allowPrivate: privateNetworksAllowed() });
  if (!fault) return null;
  if (fault === "credentials") return "The URL must not contain a username or password";
  if (fault === "private") return "The URL points to a private or local address";
  if (fault === "not_found") return "The URL's host could not be found";
  return "A valid HTTPS URL is required";
}

/**
 * Why a connection may not sync with this address, or null when it may. A sentence for
 * whoever typed it. `allowHttp` is for calendar feeds, some of which are still served
 * over plain http.
 */
export async function connectionUrlProblem(url: string, options: { allowHttp?: boolean } = {}): Promise<string | null> {
  const allowHttp = Boolean(options.allowHttp);
  const fault = await addressFault(url, { allowHttp, allowPrivate: connectionPrivateNetworksAllowed() });
  if (!fault) return null;
  if (fault === "credentials") return "The address must not contain a username or password.";
  if (fault === "private") return CONNECTION_ADDRESS_REFUSED;
  if (fault === "not_found") return "No server was found at that address. Check it for a typo.";
  return allowHttp ? "Enter a full address, starting with https:// or http://" : "Enter a full address, starting with https://";
}

export interface SafeRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** How long to wait: for the answer to start, between its parts, and for the whole of it. Default 10 seconds. */
  timeoutMs?: number;
  /** The most of the answer's body to read, in bytes. Default 4,000. */
  maxBytes?: number;
  /** What to do with an answer longer than that: keep its start (the default), or give up on it. */
  onTooLarge?: "truncate" | "fail";
  /** Let the address be plain http. Default false. */
  allowHttp?: boolean;
  /** Let the address be private or local. Default: what the operator set for webhooks. */
  allowPrivate?: boolean;
}

export interface SafeResponse {
  status: number;
  body: string;
  /** Where a redirect points, when the answer is one. It is not followed here. */
  location: string | null;
}

/** The request was not made, because it would have gone to a private or local address. */
export class PrivateAddressError extends Error {
  constructor() {
    super("Refusing to connect to a private or local address");
    this.name = "PrivateAddressError";
  }
}

/** The answer was longer than the caller was willing to read. */
export class TooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`The answer was larger than ${formatSize(maxBytes)}`);
    this.name = "TooLargeError";
    this.maxBytes = maxBytes;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

/**
 * Make one request to an address a workspace chose and return what came back. Redirects
 * are not followed (a redirect is the usual way round an address check), and the address
 * the name resolves to is checked at the moment of connecting, so a name that answered
 * with a public address when it was saved cannot later be pointed inside.
 */
export function safeRequest(
  url: string,
  options: SafeRequestOptions = {},
  // The request function, so the plumbing can be tested against a local plain-HTTP server.
  transport?: typeof https.request,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error("Invalid URL")); return; }
    const plain = parsed.protocol === "http:";
    if (parsed.protocol !== "https:" && !(plain && options.allowHttp)) {
      reject(new Error(options.allowHttp ? "Only http and https URLs are connected to" : "Only https URLs are connected to"));
      return;
    }
    if (parsed.username || parsed.password) { reject(new Error("The URL must not contain a username or password")); return; }
    const allowPrivate = options.allowPrivate ?? privateNetworksAllowed();
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) { reject(new PrivateAddressError()); return; }

    const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
      dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
        if (error) { callback(error, "", 0); return; }
        const list = addresses as dns.LookupAddress[];
        if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
          callback(new PrivateAddressError(), "", 0);
          return;
        }
        if ((lookupOptions as dns.LookupOptions).all) (callback as unknown as (err: null, list: dns.LookupAddress[]) => void)(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    };

    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxBytes = options.maxBytes ?? 4000;
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const send = transport ?? ((plain ? http.request : https.request) as typeof https.request);

    let settled = false;
    const finish = (error: Error | null, response?: SafeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(response!);
    };

    const request = send(parsed, { method, headers, lookup, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : null;
      // Nothing here asks for a compressed answer, but a server may send one all the same.
      const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
      const unpack = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
      const stream: NodeJS.ReadableStream = unpack ? response.pipe(unpack) : response;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        if (size > maxBytes) return; // already over: the rest is not kept
        chunks.push(chunk);
        size += chunk.length;
        if (size > maxBytes && options.onTooLarge === "fail") {
          request.destroy();
          finish(new TooLargeError(maxBytes));
        }
      });
      stream.on("end", () => finish(null, { status, body: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), location }));
      stream.on("error", (error: Error) => finish(error));
      response.on("error", (error: Error) => finish(error));
    });
    // The socket's own timeout covers a silence; this covers an answer that keeps trickling.
    const deadline = setTimeout(() => request.destroy(new Error("Timed out")), timeoutMs);
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", (error: Error) => finish(error));
    request.end(options.body);
  });
}

/** POST a body to an https URL and return what came back. How a webhook is delivered. */
export async function safePost(
  url: string,
  options: { headers: Record<string, string>; body: string; timeoutMs?: number },
  transport?: typeof https.request,
): Promise<{ status: number; body: string }> {
  const response = await safeRequest(url, { method: "POST", headers: options.headers, body: options.body, timeoutMs: options.timeoutMs }, transport);
  return { status: response.status, body: response.body };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET an address and follow where it redirects, at most `maxRedirects` times (5 by
 * default). Every hop goes through safeRequest, so a public address cannot be used to
 * hand the request on to a private one. For reading a feed: nothing is sent but the
 * headers given, so there is no credential for a redirect to carry off.
 */
export async function safeGet(
  url: string,
  options: Omit<SafeRequestOptions, "method" | "body"> & { maxRedirects?: number } = {},
  transport?: typeof https.request,
): Promise<SafeResponse> {
  const { maxRedirects = 5, ...rest } = options;
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await safeRequest(current, { ...rest, method: "GET" }, transport);
    if (!REDIRECTS.has(response.status) || !response.location) return response;
    if (hop >= maxRedirects) throw new Error("Too many redirects");
    try { current = new URL(response.location, current).toString(); } catch { throw new Error("The address redirects somewhere that is not an address"); }
  }
}
