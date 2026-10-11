// Firecrawl: the reader. A URL in, the page's readable content out as markdown, or as JSON
// against a schema. Everything here returns normalised types — nothing Firecrawl-shaped
// leaks past this module, so a second reader could replace it without touching a caller.
//
// Built against API v2 (api.firecrawl.dev/v2) as documented on 2026-10-11. Two shapes the
// docs and the OpenAPI spec disagree about, resolved the safe way:
//
//   `formats` is sent as objects (`[{type:"markdown"}]`), never bare strings. The prose
//   examples use strings and the API accepts them, but only the object form is in the spec
//   and only it works for every format.
//
//   The answer is read at `body.data.markdown`, not `body.markdown`. Firecrawl's own SDK
//   unwraps `data` before handing it back; raw requests do not, and reading the wrong level
//   yields undefined rather than an error.
import { PageText, ResearchRefused } from "@/lib/research/providers";

/** Overridable so tests can point at a local stand-in instead of stubbing global fetch. */
export function firecrawlUrl(path: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2").replace(/\/$/, "");
  return `${base}${path}`;
}

/** One page read. 1 credit. */
export const CREDITS_PER_PAGE = 1;
/** One page read into a schema: the base credit plus Firecrawl's LLM pass. */
export const CREDITS_PER_EXTRACT = 5;
/** How long Firecrawl may spend on one page. Its own ceiling is 300s; a prospect's site is not worth that. */
const PAGE_TIMEOUT_MS = 30_000;
/** How long we wait for Firecrawl itself, which is longer than the page timeout it is honouring. */
const REQUEST_TIMEOUT_MS = 45_000;

interface ScrapeBody {
  success?: boolean;
  data?: {
    markdown?: string | null;
    json?: unknown;
    metadata?: { title?: string | null; sourceURL?: string; url?: string; statusCode?: number; error?: string | null };
  };
  error?: string;
}

/**
 * A refusal, told apart from a page Firecrawl simply does not have.
 *
 * 408 (the page outran its timeout), 429 (rate or concurrency limit) and the 5xx family are
 * the provider's problem and may succeed later, so they are marked retryable. A bad key, no
 * credits or a blocked site will answer the same way however many times it is asked.
 */
function refusal(status: number, body: ScrapeBody | null): ResearchRefused {
  const said = body?.error?.trim();
  const why = status === 0 ? "it could not be reached"
    : status === 401 ? "the API key was not accepted"
      : status === 402 ? "the Firecrawl account is out of credits"
        : status === 403 ? said || "it refused this site"
          : status === 408 ? "the page took too long to load"
            : status === 429 ? "too many requests at once; try again shortly"
              : status >= 500 ? `it answered ${status}`
                : said || `it answered ${status}`;
  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  return new ResearchRefused("firecrawl", status, `Firecrawl could not be asked: ${why}`, retryable);
}

async function ask(path: string, apiKey: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<ScrapeBody> {
  let response: Response;
  try {
    response = await fetch(firecrawlUrl(path), {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // No answer at all: a dropped connection or our own timeout. Status 0, as in the Apollo
    // clients, so callers have one shape to branch on.
    throw refusal(0, null);
  }
  const payload = await response.json().catch(() => null) as ScrapeBody | null;
  if (!response.ok) throw refusal(response.status, payload);
  return payload ?? {};
}

/** The address is one a reader could usefully be pointed at. */
export function readableUrl(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // A scraper runs on the provider's machines, so a local address is not a way into this
  // network — it is simply a credit spent on nothing. Refused here rather than sent.
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".test")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
  if (!host.includes(".")) return null;
  return parsed.toString();
}

/** Turn Firecrawl's answer into a PageText, or null when there was no readable content. */
function readPageBody(url: string, body: ScrapeBody): PageText | null {
  const markdown = body.data?.markdown?.trim();
  if (!markdown) return null;
  const meta = body.data?.metadata;
  return {
    url,
    final_url: meta?.url || meta?.sourceURL || url,
    title: meta?.title?.trim() || null,
    markdown,
  };
}

/**
 * Read one page. Null when Firecrawl reached it and found nothing worth returning (an empty
 * page, a redirect to nothing); ResearchRefused when Firecrawl itself would not answer.
 */
export async function readPage(url: string, apiKey: string): Promise<PageText | null> {
  const body = await ask("/scrape", apiKey, {
    url,
    formats: [{ type: "markdown" }],
    onlyMainContent: true,
    timeout: PAGE_TIMEOUT_MS,
    blockAds: true,
  });
  return readPageBody(url, body);
}

/**
 * Read one page into a shape. Costs five credits rather than one, because Firecrawl runs a
 * model over the page, so it is worth it only when the fields are known in advance.
 *
 * `data.json` is absent from Firecrawl's published OpenAPI schema though its docs show it,
 * so it is read defensively and typed as unknown for the caller to narrow.
 */
export async function extractPage(url: string, apiKey: string, schema: Record<string, unknown>, prompt?: string): Promise<unknown | null> {
  const body = await ask("/scrape", apiKey, {
    url,
    formats: [{ type: "json", schema, ...(prompt ? { prompt } : {}) }],
    onlyMainContent: true,
    timeout: PAGE_TIMEOUT_MS,
  });
  const extracted = body.data?.json;
  return extracted === undefined || extracted === null ? null : extracted;
}

export interface CrawlStarted { id: string }
export interface CrawlState {
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  credits_used: number;
  pages: PageText[];
  /** The next page of results, or null when there are no more. */
  next: string | null;
}

/**
 * Start a crawl. Always pass a page limit: Firecrawl's own default is 10,000, which at a
 * credit a page is a bill nobody asked for.
 *
 * `include` patterns are RE2 regexes matched against the pathname, and the START URL is
 * itself tested against them — so crawling a site's root with include `^/careers` matches
 * nothing and returns zero pages. Callers should start at the subtree they want.
 */
export async function startCrawl(
  url: string,
  apiKey: string,
  options: { limit: number; include?: string[]; exclude?: string[] },
): Promise<CrawlStarted> {
  const body = await ask("/crawl", apiKey, {
    url,
    limit: options.limit,
    ...(options.include?.length ? { includePaths: options.include } : {}),
    ...(options.exclude?.length ? { excludePaths: options.exclude } : {}),
    scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true, timeout: PAGE_TIMEOUT_MS },
  }) as ScrapeBody & { id?: string };
  const id = typeof body.id === "string" ? body.id : null;
  if (!id) throw new ResearchRefused("firecrawl", 0, "Firecrawl started a crawl but did not say which one");
  return { id };
}

interface CrawlStatusBody {
  status?: string;
  completed?: number;
  total?: number;
  creditsUsed?: number;
  next?: string | null;
  data?: Array<{ markdown?: string | null; metadata?: { title?: string | null; sourceURL?: string; url?: string } }>;
}

/**
 * Where a crawl has got to. Polling is free.
 *
 * `next` is present on unfinished crawls too, so its absence does not mean the crawl is
 * over: the caller stops on `status`, and pages through `next` only once it is terminal.
 */
export async function crawlState(id: string, apiKey: string): Promise<CrawlState> {
  const body = await ask(`/crawl/${encodeURIComponent(id)}`, apiKey, null, "GET") as CrawlStatusBody;
  const status = body.status === "completed" || body.status === "failed" || body.status === "cancelled" ? body.status : "scraping";
  const pages: PageText[] = [];
  for (const row of body.data ?? []) {
    const markdown = row.markdown?.trim();
    if (!markdown) continue;
    const asked = row.metadata?.sourceURL || row.metadata?.url || "";
    pages.push({ url: asked, final_url: row.metadata?.url || asked, title: row.metadata?.title?.trim() || null, markdown });
  }
  return {
    status,
    completed: body.completed ?? 0,
    total: body.total ?? 0,
    credits_used: body.creditsUsed ?? 0,
    pages,
    next: typeof body.next === "string" ? body.next : null,
  };
}

/** What the workspace has left to spend, so a cost preview can warn before it refuses. */
export async function remainingCredits(apiKey: string): Promise<number | null> {
  const body = await ask("/team/credit-usage", apiKey, null, "GET") as { data?: { remainingCredits?: number } };
  const left = body.data?.remainingCredits;
  return typeof left === "number" ? left : null;
}
