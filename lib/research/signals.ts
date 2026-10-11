// Buying signals read off a company's own website.
//
// Shaped after lib/signals/detection.ts, which derives signals from Apollo, because the
// hard-won parts of that design are not Apollo-specific:
//
//   The comparison is a pure function. compareResearchSnapshots takes two readings and
//   returns what changed, with no database and no network, so the judgement about what
//   counts as a signal is testable on its own.
//
//   The first reading is a baseline, not news. Everything on a page looks new the first
//   time it is read, so only facts that are self-evidently recent (an already-large job
//   board, a funding round with a fresh date) are reported on a first read. A technology
//   list is not, because every entry would look like an adoption.
//
//   Facts are extracted into a schema rather than pattern-matched out of prose. Counting
//   the word "hiring" on a page is how you report a careers page's footer as a signal;
//   asking the reader for `open_roles` as a number gives something that can be compared
//   with last week's number.
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { ingestSignal } from "@/lib/platform/signals";
import { CREDITS_PER_EXTRACT, extractPage, readableUrl } from "@/lib/research/firecrawl";
import { ResearchRefused } from "@/lib/research/providers";

type DB = DatabaseType.Database;

/** The kind of reading this is, and the key its snapshot is stored under. */
export const SNAPSHOT_KIND = "website";
/** Companies read in one request. Each is a schema extraction, which is slow and costs five credits. */
export const SIGNAL_BATCH = 5;
export const MAX_SIGNAL_RUN = 300;
/** A funding round dated within this many days is news on a first reading. */
const FRESH_FUNDING_DAYS = 60;
/** A company already advertising this many roles is worth reporting on a first reading. */
const HIRING_ROLES = 5;
const DAY_MS = 86_400_000;

/** What one reading of a company's site found. Stored so the next one can tell what changed. */
export interface ResearchSnapshot {
  read_at: string;
  /** Roles advertised, when the page said. Null when it did not say. */
  open_roles: number | null;
  /** Named products or tools the page says they use or build on. */
  technologies: string[];
  /** A funding round the page mentions, if any. */
  funding_stage: string | null;
  funding_date: string | null;
  /** Named pricing tiers, which changing is a sign of a product move. */
  pricing_tiers: string[];
}

/** The shape the reader is asked to fill. Plain JSON Schema, as Firecrawl requires. */
export const WEBSITE_SCHEMA = {
  type: "object",
  properties: {
    open_roles: { type: ["integer", "null"], description: "How many distinct open jobs this page advertises. Null if the page is not about jobs." },
    technologies: { type: "array", items: { type: "string" }, description: "Named products, platforms or tools this company says it uses or is built on. Names only, no descriptions." },
    funding_stage: { type: ["string", "null"], description: "A funding round this page mentions, such as Seed or Series B. Null if none is mentioned." },
    funding_date: { type: ["string", "null"], description: "The date of that round as YYYY-MM-DD, if the page gives one. Null otherwise." },
    pricing_tiers: { type: "array", items: { type: "string" }, description: "Named pricing plans, if this page lists them. Names only." },
  },
  required: ["open_roles", "technologies", "funding_stage", "funding_date", "pricing_tiers"],
} as const;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map((item) => text(item)).filter((item): item is string => item !== null))].sort() : [];
/** A date only counts if it is a real calendar day, so a made-up one cannot age a signal. */
const day = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return null;
  const date = new Date(`${match[0]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0] ? null : match[0];
};

/** Turn whatever the reader returned into a snapshot. Nothing provider-shaped survives. */
export function readSnapshot(extracted: unknown, readAt: string): ResearchSnapshot {
  const row = (extracted && typeof extracted === "object" ? extracted : {}) as Record<string, unknown>;
  const roles = typeof row.open_roles === "number" && Number.isFinite(row.open_roles) ? Math.max(0, Math.trunc(row.open_roles)) : null;
  return {
    read_at: readAt,
    open_roles: roles,
    technologies: strings(row.technologies),
    funding_stage: text(row.funding_stage),
    funding_date: day(row.funding_date),
    pricing_tiers: strings(row.pricing_tiers),
  };
}

/** One signal worth recording, in the shape detection.ts uses. */
export interface Detected {
  type: "hiring" | "funding" | "technology" | "product_intent";
  title: string;
  description: string;
  score: number;
  occurred_at: string;
}

/**
 * What changed between two readings of a company's website.
 *
 * Pure, so the question "is this actually a signal?" can be argued about in a test rather
 * than in production. `previous` null means this is the first reading, which is a baseline:
 * only self-evidently recent facts are reported, because otherwise every company would
 * announce its entire technology stack the day it was first read.
 */
export function compareResearchSnapshots(
  name: string,
  previous: ResearchSnapshot | null,
  current: ResearchSnapshot,
  now: Date = new Date(),
): Detected[] {
  const found: Detected[] = [];

  if (current.funding_date) {
    const isNew = previous
      ? current.funding_date > (previous.funding_date ?? "")
      : now.getTime() - Date.parse(`${current.funding_date}T00:00:00Z`) <= FRESH_FUNDING_DAYS * DAY_MS;
    if (isNew) {
      found.push({
        type: "funding", score: 70, occurred_at: `${current.funding_date}T00:00:00.000Z`,
        title: `${name} mentions ${current.funding_stage ? `a ${current.funding_stage} round` : "new funding"} on its website`,
        description: `Dated ${current.funding_date}, read from their own site`,
      });
    }
  }

  if (current.open_roles !== null) {
    const before = previous?.open_roles ?? null;
    // A jump, not a wobble: three roles or a quarter more, whichever is larger, so a board
    // that gains one listing does not report itself as a hiring push.
    const grew = before !== null && current.open_roles >= before + Math.max(3, Math.ceil(before * 0.25));
    const alreadyBig = before === null && previous === null && current.open_roles >= HIRING_ROLES;
    if (grew || alreadyBig) {
      found.push({
        type: "hiring", score: 50, occurred_at: current.read_at,
        title: `${name} is advertising ${current.open_roles} open ${current.open_roles === 1 ? "role" : "roles"}`,
        description: before !== null ? `Up from ${before} when their site was last read` : "Read from their careers page",
      });
    }
  }

  // Only on a later reading: on a first one every entry would look like an adoption.
  if (previous) {
    const added = current.technologies.filter((tool) => !previous.technologies.includes(tool));
    if (added.length > 0) {
      found.push({
        type: "technology", score: 40, occurred_at: current.read_at,
        title: `${name} now mentions ${added.slice(0, 3).join(", ")}${added.length > 3 ? ` and ${added.length - 3} more` : ""}`,
        description: "New on their website since it was last read",
      });
    }
    const tiers = current.pricing_tiers.filter((tier) => !previous.pricing_tiers.includes(tier));
    if (tiers.length > 0) {
      found.push({
        type: "product_intent", score: 40, occurred_at: current.read_at,
        title: `${name} has added a ${tiers.slice(0, 2).join(" and ")} plan`,
        description: "Their pricing page lists a tier it did not before",
      });
    }
  }

  return found;
}

/** A company worth reading, and where from. */
export interface SignalCandidate { id: string; name: string; website: string | null }

export function signalCandidates(db: DB, workspaceId: string, companyIds: string[]): SignalCandidate[] {
  if (companyIds.length === 0) return [];
  const placeholders = companyIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, name, COALESCE(NULLIF(website, ''), NULLIF(domain, '')) AS website
    FROM companies WHERE workspace_id = ? AND id IN (${placeholders})
  `).all(workspaceId, ...companyIds) as SignalCandidate[];
  return rows.map((row) => ({ ...row, website: readableUrl(row.website) }));
}

export interface SignalCost {
  selected: number;
  eligible: number;
  eligible_ids: string[];
  no_website: number;
  /** Five credits a company: a schema extraction, not a plain read. */
  credits: number;
  batch: number;
  /** How many have been read before, so the first run's baseline is not a surprise. */
  read_before: number;
}

export function signalCost(db: DB, workspaceId: string, candidates: SignalCandidate[], selected: number): SignalCost {
  const eligible = candidates.filter((row) => row.website !== null);
  const ids = eligible.map((row) => row.id);
  const before = ids.length === 0 ? 0 : (db.prepare(
    `SELECT COUNT(*) AS c FROM research_findings WHERE workspace_id = ? AND kind = ? AND company_id IN (${ids.map(() => "?").join(",")})`,
  ).get(workspaceId, SNAPSHOT_KIND, ...ids) as { c: number }).c;
  return {
    selected,
    eligible: eligible.length,
    eligible_ids: ids,
    no_website: candidates.length - eligible.length,
    credits: eligible.length * CREDITS_PER_EXTRACT,
    batch: SIGNAL_BATCH,
    read_before: before,
  };
}

export function lastSnapshot(db: DB, workspaceId: string, companyId: string): ResearchSnapshot | null {
  const row = db.prepare("SELECT snapshot_json FROM research_findings WHERE workspace_id = ? AND company_id = ? AND kind = ?")
    .get(workspaceId, companyId, SNAPSHOT_KIND) as { snapshot_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.snapshot_json) as ResearchSnapshot; } catch { return null; }
}

export function saveSnapshot(db: DB, workspaceId: string, companyId: string, url: string, provider: string, snapshot: ResearchSnapshot): void {
  db.prepare(`
    INSERT INTO research_findings (id, workspace_id, company_id, kind, provider, url, snapshot_json, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id, company_id, kind) DO UPDATE SET
      provider = excluded.provider, url = excluded.url, snapshot_json = excluded.snapshot_json, checked_at = excluded.checked_at
  `).run(randomUUID(), workspaceId, companyId, SNAPSHOT_KIND, provider, url, JSON.stringify(snapshot));
}

export type SignalOutcome = "signals" | "no_change" | "baseline" | "no_website" | "unreadable";

/**
 * Read one company's site and record whatever changed since last time.
 *
 * Signals are recorded against the company, not a contact, which means they score the
 * company and deliberately enrol nobody: signal rules are written for a contact, and a
 * company-scoped signal has none to act on. The snapshot is saved whatever happens, so the
 * next run has something to compare against even when this one found nothing.
 */
export async function readCompanySignals(
  db: DB,
  workspaceId: string,
  candidate: SignalCandidate,
  apiKey: string,
  now: Date = new Date(),
): Promise<{ outcome: SignalOutcome; detected: number }> {
  if (!candidate.website) return { outcome: "no_website", detected: 0 };

  const extracted = await extractPage(candidate.website, apiKey, WEBSITE_SCHEMA as unknown as Record<string, unknown>);
  if (extracted === null) return { outcome: "unreadable", detected: 0 };

  const previous = lastSnapshot(db, workspaceId, candidate.id);
  const snapshot = readSnapshot(extracted, now.toISOString());
  const detected = compareResearchSnapshots(candidate.name, previous, snapshot, now);

  for (const signal of detected) {
    ingestSignal({
      workspaceId, companyId: candidate.id, type: signal.type, title: signal.title,
      description: signal.description, score: signal.score, source: "firecrawl",
      occurredAt: signal.occurred_at, metadata: { url: candidate.website },
    });
  }
  saveSnapshot(db, workspaceId, candidate.id, candidate.website, "firecrawl", snapshot);

  if (detected.length > 0) return { outcome: "signals", detected: detected.length };
  return { outcome: previous ? "no_change" : "baseline", detected: 0 };
}

export { ResearchRefused };
