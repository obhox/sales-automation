import { resolveMx, resolveTxt } from "dns/promises";

// What a sending domain publishes in DNS, and what Linki makes of it.
//
// Looking the records up and judging them are kept apart: the judging is pure, so it can
// be tested without the network, and so a later check can be compared with an earlier one.

/** pass: in place and sound. weak: in place, but it does less than it should. fail: missing. */
export type RecordStatus = "pass" | "weak" | "fail";

export interface DnsRecord {
  status: RecordStatus;
  /** The record as published, or what stands for it ("5 · aspmx.l.google.com"). Null when there is none. */
  value: string | null;
  /** Why it is weak or failing, in a sentence. Null when it passes. */
  note: string | null;
  /** The lookup itself did not get an answer, so "missing" is not known to be true. */
  lookup_failed?: boolean;
}

export interface DkimRecord extends DnsRecord {
  /** The selector the key was found under. */
  selector: string | null;
  /** RSA key size, when it could be told from the record. */
  bits: number | null;
  selectors_checked: string[];
}

export interface DmarcRecord extends DnsRecord {
  /** none, quarantine or reject. */
  policy: string | null;
}

export interface DomainDns {
  domain: string;
  spf: DnsRecord;
  dkim: DkimRecord;
  dmarc: DmarcRecord;
  mx: DnsRecord;
}

export interface DnsResolver {
  /** Each TXT record at a name as one string. An empty list when the name has none. */
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
}

/** Selectors tried when none is named, most common first. */
export const COMMON_DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "s1", "s2", "k1", "mail", "dkim", "pm", "smtp"] as const;

export function normaliseDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
}

/** The domain an address sends from, or null for something that is not an address. */
export function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 1) return null;
  const domain = normaliseDomain(email.slice(at + 1));
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain) ? domain : null;
}

export function isDomain(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(value);
}

export function isDkimSelector(value: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/i.test(value);
}

// ── Judging ───────────────────────────────────────────────────────────────────

export function evaluateSpf(records: string[]): DnsRecord {
  const spf = records.filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));
  if (spf.length === 0) return { status: "fail", value: null, note: "No SPF record. Receiving servers cannot tell which servers may send for this domain." };
  const value = spf[0].trim();
  if (spf.length > 1) return { status: "weak", value, note: "More than one SPF record. Receiving servers treat that as an error; merge them into one." };
  if (/(^|\s)\+?all(\s|$)/i.test(value) && !/(^|\s)[-~?]all(\s|$)/i.test(value)) return { status: "weak", value, note: "The record ends in +all, which lets any server send as this domain. End it in ~all or -all." };
  if (/(^|\s)\?all(\s|$)/i.test(value)) return { status: "weak", value, note: "The record ends in ?all, which gives no verdict on other servers. End it in ~all or -all." };
  return { status: "pass", value, note: null };
}

export function evaluateDmarc(records: string[]): DmarcRecord {
  const dmarc = records.filter((record) => /^v=dmarc1(\s*;|$)/i.test(record.trim()));
  if (dmarc.length === 0) return { status: "fail", value: null, policy: null, note: "No DMARC record. Start with p=none and a reporting address, then tighten it." };
  const value = dmarc[0].trim();
  const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
  if (policy === "quarantine" || policy === "reject") return { status: "pass", value, policy, note: null };
  if (policy === "none") return { status: "weak", value, policy, note: "The policy is p=none, which only reports. p=quarantine tells receivers to act on mail that fails, and protects the domain from being forged." };
  return { status: "weak", value, policy, note: "The record has no policy receivers understand. Set p=none, p=quarantine or p=reject." };
}

/** The key size an RSA DKIM record carries, judged from the length of its p= value. */
export function dkimKeyBits(record: string): number | null {
  if (/(?:^|;)\s*k\s*=\s*ed25519/i.test(record)) return null;
  const key = /(?:^|;)\s*p\s*=\s*([A-Za-z0-9+/=\s]+)/.exec(record)?.[1]?.replace(/\s/g, "") ?? "";
  if (!key) return null;
  const bytes = Math.floor((key.replace(/=+$/, "").length * 3) / 4);
  // The key sits inside a wrapper of about 30 bytes.
  if (bytes >= 500) return 4096;
  if (bytes >= 280) return 2048;
  if (bytes >= 150) return 1024;
  return 512;
}

export function evaluateDkim(records: string[], selector: string | null, selectorsChecked: string[]): DkimRecord {
  const found = records.find((record) => /v=dkim1|(?:^|;)\s*p\s*=/i.test(record));
  if (!found || !selector) {
    return {
      status: "fail", value: null, selector: null, bits: null, selectors_checked: selectorsChecked,
      note: `No DKIM key found under ${selectorsChecked.length === 1 ? `the selector ${selectorsChecked[0]}` : "the usual selectors"}. Switch DKIM signing on at your mail provider, publish the record it gives you, and enter its selector here.`,
    };
  }
  const value = found.trim();
  if (/(?:^|;)\s*p\s*=\s*(;|$)/.test(value)) return { status: "fail", value, selector, bits: null, selectors_checked: selectorsChecked, note: `The key under ${selector} has been revoked (its p= is empty).` };
  const bits = dkimKeyBits(value);
  if (bits !== null && bits < 1024) return { status: "weak", value, selector, bits, selectors_checked: selectorsChecked, note: `The key under ${selector} is shorter than 1024 bits. Many receivers ignore keys that short; publish a 2048-bit key.` };
  return { status: "pass", value, selector, bits, selectors_checked: selectorsChecked, note: null };
}

export function evaluateMx(rows: Array<{ exchange: string; priority: number }>): DnsRecord {
  const sorted = [...rows].filter((row) => row.exchange && row.exchange !== ".").sort((a, b) => a.priority - b.priority);
  if (sorted.length === 0) return { status: "fail", value: null, note: "No MX record. The domain cannot receive mail, so replies and bounces have nowhere to go." };
  return { status: "pass", value: `${sorted[0].priority} · ${sorted[0].exchange.replace(/\.$/, "")}${sorted.length > 1 ? ` (+${sorted.length - 1})` : ""}`, note: null };
}

// ── Looking up ────────────────────────────────────────────────────────────────

const NOT_THERE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENONAME"]);

/** The system resolver. A name with no such record is an empty list; anything else throws. */
export const systemResolver: DnsResolver = {
  async txt(name) {
    try {
      return (await resolveTxt(name)).map((parts) => parts.join(""));
    } catch (error) {
      if (NOT_THERE.has(String((error as { code?: string })?.code))) return [];
      throw error;
    }
  },
  async mx(name) {
    try {
      return await resolveMx(name);
    } catch (error) {
      if (NOT_THERE.has(String((error as { code?: string })?.code))) return [];
      throw error;
    }
  },
};

const LOOKUP_FAILED = (what: string, error: unknown) => `${what} could not be looked up just now (${error instanceof Error ? error.message : String(error)}).`;

/**
 * Look up and judge a domain's SPF, DKIM, DMARC and MX records. Never throws: a lookup
 * that gets no answer is reported on its record as `lookup_failed`.
 */
export async function lookupDomainDns(rawDomain: string, options: { selector?: string | null; resolver?: DnsResolver } = {}): Promise<DomainDns> {
  const domain = normaliseDomain(rawDomain);
  const resolver = options.resolver ?? systemResolver;
  const failed = <T extends DnsRecord>(record: T, what: string, error: unknown): T => ({ ...record, status: "fail", note: LOOKUP_FAILED(what, error), lookup_failed: true });

  const spf = resolver.txt(domain).then(evaluateSpf).catch((error) => failed(evaluateSpf([]), "The SPF record", error));
  const dmarc = resolver.txt(`_dmarc.${domain}`).then(evaluateDmarc).catch((error) => failed(evaluateDmarc([]), "The DMARC record", error));
  const mx = resolver.mx(domain).then(evaluateMx).catch((error) => failed(evaluateMx([]), "The MX record", error));

  const preferred = options.selector?.trim().toLowerCase();
  const selectors = [...new Set([preferred, ...COMMON_DKIM_SELECTORS].filter((selector): selector is string => Boolean(selector) && isDkimSelector(selector!)))];
  const dkim = (async (): Promise<DkimRecord> => {
    let lookupError: unknown = null;
    for (const selector of selectors) {
      try {
        const records = await resolver.txt(`${selector}._domainkey.${domain}`);
        if (records.some((record) => /v=dkim1|(?:^|;)\s*p\s*=/i.test(record))) return evaluateDkim(records, selector, selectors);
      } catch (error) {
        lookupError = error;
      }
    }
    const missing = evaluateDkim([], null, selectors);
    return lookupError ? failed(missing, "The DKIM key", lookupError) : missing;
  })();

  const [spfResult, dkimResult, dmarcResult, mxResult] = await Promise.all([spf, dkim, dmarc, mx]);
  return { domain, spf: spfResult, dkim: dkimResult, dmarc: dmarcResult, mx: mxResult };
}

/** What to do about a domain's records, most useful first. Empty when there is nothing to do. */
export function dnsAdvice(dns: DomainDns): string[] {
  return [dns.spf, dns.dkim, dns.dmarc, dns.mx].map((record) => record.note).filter((note): note is string => Boolean(note));
}
