/**
 * Tells a human opening an email apart from a machine fetching the pixel for them.
 *
 * Corporate mail security (Defender Safe Links, Proofpoint, Mimecast, Barracuda …) fetches
 * every image and follows every link the moment a message is delivered, so an untouched
 * campaign produces a near-100% "open rate" made entirely of scanners. Counting those as
 * engagement does not just inflate a number — it ranks the wrong contacts as warm.
 *
 * Two independent signals, because neither is sufficient alone:
 *   1. The user-agent, when the fetcher identifies itself (many scanners do).
 *   2. The gap between send and hit. Scanners fire in seconds; humans do not. This is the
 *      signal that catches the scanners that disguise their user-agent, and it is also what
 *      catches Apple Mail Privacy Protection, which prefetches every image on receipt
 *      regardless of whether the message is ever read.
 *
 * Nothing is discarded on the strength of this call: hits are recorded either way and the
 * verdict is stored alongside them, so analytics can show verified opens and raw pixel hits
 * side by side and the thresholds here can be re-tuned against real history later.
 */

/** Hits inside this window after the send are machine prefetches, not reads. */
export const DEFAULT_PREFETCH_WINDOW_SECONDS = 15;

export type BotVerdict = {
  bot: boolean;
  /** Machine-readable reason, or null when the hit looks human. */
  reason: BotReason | null;
  /** Seconds between the send and this hit; null when the send time is unknown. */
  gapSeconds: number | null;
};

export type BotReason =
  | "scanner_user_agent"   // the fetcher named itself as a security gateway or link scanner
  | "automation_user_agent" // a generic HTTP client / crawler, not a mail client
  | "prefetch"             // fired too soon after the send for anyone to have read it
  | "known_bot_ip";        // source address is in an operator-configured scanner range

/**
 * Mail-security gateways, link scanners and preview unfurlers that identify themselves.
 *
 * Deliberately excludes plain "Microsoft Outlook" and "Microsoft Office": those are the real
 * desktop clients a human reads mail in, and matching them would delete genuine opens. Only
 * the scanning and preview services Microsoft runs alongside them are listed.
 */
const SCANNER_PATTERNS: RegExp[] = [
  /\b(?:proofpoint|pfpt)\b/i,
  /\bmimecast\b/i,
  /\bbarracuda\b/i,
  /\bironport\b/i,
  /\b(?:messagelabs|symantec|broadcom-?email)\b/i,
  /\b(?:forcepoint|websense)\b/i,
  /\bforti(?:mail|net|guard)\b/i,
  /\b(?:sophos|utm-?scanner)\b/i,
  /\b(?:trendmicro|tmase|trend-?micro)\b/i,
  /\b(?:zscaler|netskope)\b/i,
  /\b(?:cloudmark|spamtitan|vade(?:secure)?|hornetsecurity|retarus|clearswift|cyren)\b/i,
  /\b(?:abnormal|avanan|greathorn|ironscales|sublime-?security|area1|agari)\b/i,
  /\b(?:mcafee|trellix|eset|kaspersky|bitdefender)\b/i,
  /\bmicrosoft-?(?:wns|cryptoapi|preview)\b/i,
  /\bbingpreview\b/i,
  /\bskypeuripreview\b/i,
  /\bsafelinks\b/i,
  /\b(?:slackbot|discordbot|telegrambot|whatsapp|embedly)\b/i,
  /\bfacebookexternalhit\b/i,
  /\b(?:twitterbot|linkedinbot)\b/i,
];

/** Generic HTTP clients and crawlers. A mail client never looks like this. */
const AUTOMATION_PATTERNS: RegExp[] = [
  /\b(?:bot|crawler|spider|slurp|scanner)\b/i,
  /\bheadlesschrome\b/i,
  /\bphantomjs\b/i,
  /^curl\//i,
  /\bwget\b/i,
  /\bpython-(?:requests|urllib|httpx)\b/i,
  /\bgo-http-client\b/i,
  /^java\//i,
  /\bokhttp\b/i,
  /\blibwww-perl\b/i,
  /\bapache-httpclient\b/i,
  /\b(?:winhttp|powershell)\b/i,
  /\b(?:axios|node-fetch|got|undici|guzzle|faraday|httpie)\b/i,
];

/**
 * Gmail's image proxy. NOT a bot: Gmail fetches through it when a human displays the
 * message, so the hit is a real open that happens to be relayed. Listed so it is never
 * caught by the generic "proxy"-shaped heuristics above.
 */
const HUMAN_PROXY_PATTERNS: RegExp[] = [/\bgoogleimageproxy\b/i];

export function prefetchWindowSeconds(): number {
  const raw = Number(process.env.EMAIL_TRACKING_PREFETCH_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PREFETCH_WINDOW_SECONDS;
}

/**
 * Operator-supplied CIDR ranges to treat as scanners, comma-separated in
 * EMAIL_TRACKING_BOT_IP_CIDRS. Empty by default: vendor egress ranges change often enough
 * that shipping a stale hard-coded list would silently discard real opens. Apple publishes
 * its Mail Privacy Protection relay ranges at mask-api.icloud.com/egress-ip-ranges.csv and
 * Microsoft publishes its own; feed either in here when you want IP-level filtering on top
 * of the timing rule.
 */
export function botIpRanges(): string[] {
  return (process.env.EMAIL_TRACKING_BOT_IP_CIDRS ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean);
}

export function classifyTrackingHit(input: {
  userAgent?: string | null;
  clientIp?: string | null;
  /** When the message was accepted by the provider. Null skips the timing rule. */
  sentAt?: string | null;
  occurredAt?: string | null;
}): BotVerdict {
  const ua = (input.userAgent ?? "").trim();
  const gapSeconds = secondsBetween(input.sentAt, input.occurredAt);

  const humanProxy = HUMAN_PROXY_PATTERNS.some((p) => p.test(ua));

  if (!humanProxy && ua && SCANNER_PATTERNS.some((p) => p.test(ua)))
    return { bot: true, reason: "scanner_user_agent", gapSeconds };
  if (!humanProxy && ua && AUTOMATION_PATTERNS.some((p) => p.test(ua)))
    return { bot: true, reason: "automation_user_agent", gapSeconds };
  if (input.clientIp && ipInAnyRange(input.clientIp, botIpRanges()))
    return { bot: true, reason: "known_bot_ip", gapSeconds };

  // The timing rule applies to Gmail's proxy too: a relayed open is still an open, but one
  // that lands two seconds after the send was not displayed to anybody.
  if (gapSeconds !== null && gapSeconds >= 0 && gapSeconds < prefetchWindowSeconds())
    return { bot: true, reason: "prefetch", gapSeconds };

  return { bot: false, reason: null, gapSeconds };
}

function secondsBetween(sentAt?: string | null, occurredAt?: string | null): number | null {
  const sent = parseTimestamp(sentAt);
  const hit = parseTimestamp(occurredAt) ?? Date.now();
  if (sent === null) return null;
  return (hit - sent) / 1000;
}

/**
 * SQLite datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone marker, and it is UTC.
 * Date.parse treats that shape as local time, which on a non-UTC host shifts every send by
 * hours and would make the timing rule fire on the wrong messages.
 */
function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function ipInAnyRange(ip: string, cidrs: string[]): boolean {
  if (!cidrs.length) return false;
  const address = normalizeIpv4(ip);
  if (address === null) return false;
  return cidrs.some((cidr) => {
    const [base, bitsRaw] = cidr.split("/");
    const network = normalizeIpv4(base);
    if (network === null) return false;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((address & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

/** IPv4 only, including the ::ffff: form proxies use. IPv6 sources are never range-matched. */
function normalizeIpv4(value: string): number | null {
  const trimmed = value.trim().replace(/^::ffff:/i, "");
  const parts = trimmed.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}
