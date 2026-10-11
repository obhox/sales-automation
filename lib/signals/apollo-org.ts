// What Apollo says about a company, as detection needs it: its latest funding, the
// technologies it uses, its headcount and its open roles. Every call here spends Apollo
// credits on the workspace's own account, so nothing in this file is called unless a
// workspace has turned detection on (or asked for a run) with a cap on what it may spend.
//
// APOLLO_BASE_URL points these calls somewhere else, for a stand-in on this machine.

const DEFAULT_BASE = "https://api.apollo.io/api/v1";

export function apolloUrl(path: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.APOLLO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Apollo answered, but not with what was asked for. `status` 0: it never answered. */
export class ApolloError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApolloError";
    this.status = status;
  }
}

/** True when asking about the next account would fail the same way: the key, the credits or the rate. */
export function stopsTheRun(error: unknown): boolean {
  return error instanceof ApolloError && (error.status === 0 || error.status === 401 || error.status === 402 || error.status === 403 || error.status === 422 || error.status === 429 || error.status >= 500);
}

export interface Organization {
  apollo_id: string | null;
  name: string | null;
  headcount: number | null;
  funding_stage: string | null;
  /** The day of the latest round, YYYY-MM-DD. */
  funding_date: string | null;
  funding_total: string | null;
  technologies: string[];
}

export interface JobPosting {
  title: string;
  posted_at: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const day = (value: unknown): string | null => {
  const found = text(value);
  if (!found) return null;
  const parsed = Date.parse(found);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
};

function explain(status: number, body: unknown): string {
  const said = body && typeof body === "object" ? text((body as { error?: unknown; message?: unknown }).error) ?? text((body as { message?: unknown }).message) : null;
  if (status === 401 || status === 403) return "Apollo refused the API key";
  if (status === 402) return "The Apollo account has no credits left";
  if (status === 429) return "Apollo is limiting requests for now";
  return said ? `Apollo ${status}: ${said.slice(0, 200)}` : `Apollo answered ${status}`;
}

async function ask(url: string, apiKey: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", "X-Api-Key": apiKey }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new ApolloError(0, `Apollo could not be reached${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Look a company up by its website's domain. Null when Apollo does not know it. One credit. */
export async function fetchOrganization(domain: string, apiKey: string): Promise<Organization | null> {
  const { status, body } = await ask(apolloUrl(`/organizations/enrich?domain=${encodeURIComponent(domain)}`), apiKey);
  if (status === 404) return null;
  if (status < 200 || status >= 300) throw new ApolloError(status, explain(status, body));
  const org = body && typeof body === "object" ? (body as { organization?: Record<string, unknown> | null }).organization : null;
  if (!org || typeof org !== "object") return null;
  const technologies = Array.isArray(org.technology_names) ? org.technology_names
    : Array.isArray(org.current_technologies) ? (org.current_technologies as Array<{ name?: unknown }>).map((item) => item?.name) : [];
  return {
    apollo_id: text(org.id),
    name: text(org.name),
    headcount: typeof org.estimated_num_employees === "number" ? org.estimated_num_employees : null,
    funding_stage: text(org.latest_funding_stage),
    funding_date: day(org.latest_funding_round_date),
    funding_total: text(org.total_funding_printed) ?? (typeof org.total_funding === "number" ? String(org.total_funding) : null),
    technologies: [...new Set(technologies.map(text).filter((name): name is string => name !== null))].sort((a, b) => a.localeCompare(b)),
  };
}

/** The roles a company is advertising now. One credit. */
export async function fetchJobPostings(apolloId: string, apiKey: string): Promise<JobPosting[]> {
  const { status, body } = await ask(apolloUrl(`/organizations/${encodeURIComponent(apolloId)}/job_postings?per_page=100`), apiKey);
  if (status === 404) return [];
  if (status < 200 || status >= 300) throw new ApolloError(status, explain(status, body));
  const list = body && typeof body === "object" ? (body as { organization_job_postings?: unknown }).organization_job_postings : null;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === "object" ? { title: text((item as { title?: unknown }).title), posted_at: text((item as { posted_at?: unknown }).posted_at) } : null))
    .filter((item): item is { title: string; posted_at: string | null } => item !== null && item.title !== null);
}
