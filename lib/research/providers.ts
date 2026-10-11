// What the research providers have in common: where their keys live, what a refusal means,
// and which provider answers a given question.
//
// Two providers, deliberately not interchangeable:
//
//   Firecrawl READS. Give it a URL, get the page back as markdown, or as JSON against a
//   schema. Cheap (1 credit a page, 5 with a schema), fast, and enough for anything whose
//   address is already known.
//
//   TinyFish ACTS. Give it a goal instead of an address and its agent decides what to
//   click, types into search boxes, and walks pagination until it has the answer. It bills
//   per step ($0.016) with a default ceiling of 150 steps, so an uncapped run can cost
//   $2.40 and take a minute.
//
// So the escalation is not "Firecrawl found this page hard to parse" — re-asking a more
// expensive reader cannot help with that. It is "there is no URL to read until something
// has been clicked or signed into". That is the only case where the agent earns its price,
// and `needsInteraction` is where that judgement is written down.
import type DatabaseType from "better-sqlite3";
import { decryptSecret } from "@/lib/crypto";

type DB = DatabaseType.Database;

export const RESEARCH_PROVIDERS = ["firecrawl", "tinyfish"] as const;
export type ResearchProvider = (typeof RESEARCH_PROVIDERS)[number];

/** A page, however it was read. Nothing provider-shaped survives past the clients. */
export interface PageText {
  /** The address we asked for. */
  url: string;
  /** Where it ended up, after redirects. */
  final_url: string;
  title: string | null;
  /** The readable content, as markdown. */
  markdown: string;
}

/**
 * The provider refused: a bad key, no credits left, too many requests, or its own failure.
 *
 * Distinct from a `null` return, which means the provider worked and does not have the
 * page. A refusal applies to every remaining item in a run — asking about the next contact
 * would fail identically — so callers stop; a null is about one record, so callers carry on.
 */
export class ResearchRefused extends Error {
  readonly provider: ResearchProvider;
  /** The HTTP status, or 0 when there was no answer at all. */
  readonly status: number;
  /** Worth trying again shortly: a timeout, a rate limit, or the provider's own fault. */
  readonly retryable: boolean;

  constructor(provider: ResearchProvider, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ResearchRefused";
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

/** The workspace's key for a provider, or null when it is not connected. */
export function researchKey(db: DB, workspaceId: string, provider: ResearchProvider): string | null {
  const row = db.prepare("SELECT api_key FROM integrations WHERE key = ? AND workspace_id = ?")
    .get(provider, workspaceId) as { api_key: string | null } | undefined;
  return row?.api_key ? decryptSecret(row.api_key) : null;
}

/** Which research providers this workspace has connected. For the screens that offer an action. */
export function researchConnected(db: DB, workspaceId: string): Record<ResearchProvider, boolean> {
  return {
    firecrawl: researchKey(db, workspaceId, "firecrawl") !== null,
    tinyfish: researchKey(db, workspaceId, "tinyfish") !== null,
  };
}

/**
 * Does reading this address require acting on the page first?
 *
 * Only true for addresses that cannot yield their content to a plain read: a search page
 * whose results arrive from a query, a sign-in wall, a listing behind filters. Everything
 * else goes to Firecrawl, including pages that merely look messy — paying an agent to
 * re-read a static page buys nothing but latency and steps.
 *
 * Deliberately conservative: a false negative costs one wasted credit and falls back, while
 * a false positive costs a multi-step agent run on a page a reader would have handled.
 */
export function needsInteraction(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.toLowerCase();
  // A query string that reads like a search or a filter: the content exists only as the
  // answer to it, so there is no static address to hand a reader.
  if (/[?&](q|query|search|keyword|filter|page)=/.test(query)) return true;
  // Sign-in and application walls.
  if (/\/(login|signin|sign-in|account|auth|portal)(\/|$)/.test(path)) return true;
  // Search and job-board result pages, which are query-driven even without a query string.
  if (/\/(search|results|jobs\/search|browse)(\/|$)/.test(path)) return true;
  return false;
}
