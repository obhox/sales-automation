import dns from "dns";
import https from "https";
import net from "net";

// Webhook delivery, to an address a workspace chose. On an instance other people sign up
// to, that address must not be allowed to point back inside: at this server, at the cloud
// provider's metadata service, or at anything on the private network the instance sits on.
// Otherwise a webhook is a way to make the server fetch internal URLs, and the delivery log
// a way to read what came back.
//
// An operator whose own receivers live on a private network can allow them for the whole
// instance with WEBHOOK_ALLOW_PRIVATE_NETWORKS=true. It is a deploy-time choice, never a
// workspace's.

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

/** Why this is not somewhere a webhook may be sent, or null when it is. Looks the name up, so it can take a moment. */
export async function webhookUrlProblem(url: string): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "A valid HTTPS URL is required"; }
  if (parsed.protocol !== "https:") return "A valid HTTPS URL is required";
  if (parsed.username || parsed.password) return "The URL must not contain a username or password";
  if (privateNetworksAllowed()) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return isPrivateAddress(host) ? "The URL points to a private or local address" : null;
  try {
    const addresses = await dns.promises.lookup(host, { all: true });
    if (addresses.length === 0) return "The URL's host could not be found";
    return addresses.some((entry) => isPrivateAddress(entry.address)) ? "The URL points to a private or local address" : null;
  } catch {
    return "The URL's host could not be found";
  }
}

/**
 * POST a body to an https URL and return what came back. Redirects are not followed (a
 * redirect is the usual way round an address check), and the address the name resolves to
 * is checked at the moment of connecting, so a name that answered with a public address
 * when the webhook was saved cannot later be pointed inside.
 */
export function safePost(
  url: string,
  options: { headers: Record<string, string>; body: string; timeoutMs?: number },
  // The request function, so the plumbing can be tested against a local plain-HTTP server.
  transport: typeof https.request = https.request,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error("Invalid URL")); return; }
    if (parsed.protocol !== "https:") { reject(new Error("Only https URLs are delivered to")); return; }
    const allowPrivate = privateNetworksAllowed();
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) { reject(new Error("Refusing to deliver to a private or local address")); return; }

    const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
      dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
        if (error) { callback(error, "", 0); return; }
        const list = addresses as dns.LookupAddress[];
        if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
          callback(new Error("Refusing to deliver to a private or local address"), "", 0);
          return;
        }
        if ((lookupOptions as dns.LookupOptions).all) (callback as unknown as (err: null, list: dns.LookupAddress[]) => void)(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    };

    const request = transport(parsed, { method: "POST", headers: { ...options.headers, "content-length": String(Buffer.byteLength(options.body)) }, lookup, timeout: options.timeoutMs ?? 10_000 }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { if (size < 4000) { chunks.push(chunk); size += chunk.length; } });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 4000) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", reject);
    request.end(options.body);
  });
}
