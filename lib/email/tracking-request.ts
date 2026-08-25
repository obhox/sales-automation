import type { NextApiRequest } from "next";

/**
 * What the tracking endpoints know about whoever fetched the pixel or followed the link.
 *
 * The IP is read but never persisted — bot-detection uses it against operator-configured
 * scanner ranges and then drops it, because a recipient's address is personal data that
 * open analytics has no reason to keep.
 */
export function trackingRequestContext(req: NextApiRequest): { userAgent: string | null; clientIp: string | null } {
  return { userAgent: headerValue(req, "user-agent"), clientIp: clientIp(req) };
}

function clientIp(req: NextApiRequest): string | null {
  // Behind the deployment's reverse proxy the socket address is the proxy, so the
  // left-most x-forwarded-for entry is the original client.
  const forwarded = headerValue(req, "x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headerValue(req, "x-real-ip") ?? req.socket?.remoteAddress ?? null;
}

function headerValue(req: NextApiRequest, name: string): string | null {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, 512) : null;
}
