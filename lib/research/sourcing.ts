// Finding companies from a page that lists them: a fund's portfolio, a directory, a
// conference's exhibitors.
//
// This is the one capability where the two providers genuinely split. A portfolio page is
// a static list, so Firecrawl reads it into a schema in one request. A directory behind a
// search box has no address to read until something has been typed into it, so TinyFish's
// agent is what gets there — and because an agent run takes tens of seconds and bills per
// step, it is started, waited for briefly, and otherwise handed back as a run to poll
// rather than held open on a request that will time out.
//
// Nothing is created from a reading on its own. A sourced company is matched against what
// the workspace already has by domain, so running the same page twice adds nothing the
// second time.
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { lookupDomain } from "@/lib/companies/enrich";
import { CREDITS_PER_EXTRACT, extractPage, readableUrl } from "@/lib/research/firecrawl";
import { needsInteraction, type ResearchProvider } from "@/lib/research/providers";
import { MAX_USD_PER_RUN, agentRunState, startAgentRun } from "@/lib/research/tinyfish";

type DB = DatabaseType.Database;

/** The most companies one reading will take from a page. */
export const MAX_SOURCED = 50;
/**
 * How long a request will hold open waiting for an agent before handing back a run to poll.
 * Overridable so a test can exercise the hand-back without waiting out the real window,
 * the same way the clients' base URLs are overridable.
 */
export function agentWaitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.RESEARCH_AGENT_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
}
const AGENT_POLL_MS = 2_500;

/** The shape both providers are asked to fill, so their answers are interchangeable. */
export const SOURCING_SCHEMA = {
  type: "object",
  properties: {
    companies: {
      type: "array",
      maxItems: MAX_SOURCED,
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The company's name as the page gives it." },
          website: { type: ["string", "null"], description: "Its website, if the page links to one. Null otherwise." },
          description: { type: ["string", "null"], description: "One short line about it, if the page says. Null otherwise." },
        },
        required: ["name", "website"],
      },
    },
  },
  required: ["companies"],
} as const;

export interface SourcedCompany { name: string; website: string | null; domain: string | null; description: string | null }

const text = (value: unknown, max: number): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, max) : null;
};

/**
 * Read a provider's answer into companies worth keeping.
 *
 * A row with no name is dropped — a name is the only field that cannot be filled in later,
 * and a nameless company is a row nobody can act on. Rows are deduplicated on domain
 * within the reading, because a portfolio page commonly links the same company twice.
 */
export function readSourced(answer: unknown): SourcedCompany[] {
  const row = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
  const list = Array.isArray(row.companies) ? row.companies : [];
  const seen = new Set<string>();
  const out: SourcedCompany[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const name = text(item.name, 160);
    if (!name) continue;
    const website = readableUrl(text(item.website, 300));
    const domain = lookupDomain(website);
    const key = domain ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, website, domain, description: text(item.description, 400) });
    if (out.length >= MAX_SOURCED) break;
  }
  return out;
}

export interface SourcingPlan {
  url: string;
  /** Which provider the address calls for, and why. */
  provider: ResearchProvider;
  reason: string;
  /** Firecrawl credits this would spend, for a page it can read. */
  credits: number;
  /** Dollars an agent run could cost at its step cap, for a page it cannot. */
  max_usd: number | null;
}

/** Which provider a page calls for, decided before anything is spent. */
export function planSourcing(rawUrl: string): SourcingPlan | null {
  const url = readableUrl(rawUrl);
  if (!url) return null;
  if (needsInteraction(url)) {
    return {
      url, provider: "tinyfish", max_usd: MAX_USD_PER_RUN, credits: 0,
      reason: "This page needs a search or a sign-in before it lists anything, so an agent has to work it rather than read it.",
    };
  }
  return {
    url, provider: "firecrawl", credits: CREDITS_PER_EXTRACT, max_usd: null,
    reason: "This page lists companies as it stands, so it can be read in one request.",
  };
}

/** Read a static listing page in one request. */
export async function sourceWithFirecrawl(url: string, apiKey: string): Promise<SourcedCompany[]> {
  const extracted = await extractPage(
    url, apiKey, SOURCING_SCHEMA as unknown as Record<string, unknown>,
    "List every company this page names, with its website if one is linked.",
  );
  return readSourced(extracted);
}

export type AgentSourcing =
  | { done: true; companies: SourcedCompany[]; cost_usd: number }
  | { done: false; run_id: string; status: string };

/**
 * Work an interactive page with an agent.
 *
 * Waited for briefly and then handed back: an agent run takes tens of seconds, and holding
 * a request open for it is how a gateway times out and the steps get paid for anyway with
 * nothing to show. The run id is pollable, so the work is never lost to a closed request.
 */
export async function sourceWithTinyfish(url: string, goal: string, apiKey: string, waitMs = agentWaitMs()): Promise<AgentSourcing> {
  const started = await startAgentRun({ url, goal, schema: SOURCING_SCHEMA as unknown as Record<string, unknown> }, apiKey);
  const until = Date.now() + waitMs;
  for (;;) {
    const state = await agentRunState(started.run_id, apiKey);
    if (state.status === "completed") return { done: true, companies: readSourced(state.result), cost_usd: state.cost_usd };
    if (state.status === "failed" || state.status === "cancelled") return { done: true, companies: [], cost_usd: state.cost_usd };
    if (Date.now() >= until) return { done: false, run_id: started.run_id, status: state.status };
    await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_MS));
  }
}

/** Resume a run handed back earlier. */
export async function resumeSourcing(runId: string, apiKey: string): Promise<AgentSourcing> {
  const state = await agentRunState(runId, apiKey);
  if (state.status === "completed") return { done: true, companies: readSourced(state.result), cost_usd: state.cost_usd };
  if (state.status === "failed" || state.status === "cancelled") return { done: true, companies: [], cost_usd: state.cost_usd };
  return { done: false, run_id: runId, status: state.status };
}

export interface SourcingResult { added: number; already_known: number }

/**
 * Keep what was found, as companies this workspace did not already have.
 *
 * Matched on domain, so the same portfolio page read twice adds nothing the second time. A
 * company with no website cannot be matched that way and is matched on its name instead,
 * which is weaker but better than creating an obvious duplicate.
 *
 * They land on the Companies screen and nowhere else. Lists in this app hold contacts, not
 * companies (list_targets is the only linkage), so there is no list to add them to — and
 * inventing one would be a product decision, not a detail of sourcing. The route onward is
 * the one that already exists: Apollo's "find people" turns a company into contacts, and
 * those go in a list.
 */
export function keepSourced(db: DB, workspaceId: string, found: SourcedCompany[]): SourcingResult {
  let added = 0;
  let known = 0;
  const insert = db.prepare("INSERT INTO companies (id, workspace_id, name, website, domain, description) VALUES (?, ?, ?, ?, ?, ?)");
  const byDomain = db.prepare("SELECT id FROM companies WHERE workspace_id = ? AND lower(COALESCE(NULLIF(domain, ''), '')) = ?");
  const byName = db.prepare("SELECT id FROM companies WHERE workspace_id = ? AND lower(name) = ?");

  db.transaction(() => {
    for (const company of found) {
      const existing = company.domain
        ? byDomain.get(workspaceId, company.domain) as { id: string } | undefined
        : byName.get(workspaceId, company.name.toLowerCase()) as { id: string } | undefined;
      if (existing) { known += 1; continue; }
      const id = randomUUID();
      insert.run(id, workspaceId, company.name, company.website, company.domain, company.description);
      added += 1;
    }
  })();

  return { added, already_known: known };
}
