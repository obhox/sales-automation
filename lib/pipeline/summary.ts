// The five figures across the top of the pipeline, worked out from the opportunities.
//
// Money is added up in one currency only: the one most of the workspace's opportunities
// are in. Adding dollars to euros would give a number that means nothing, so opportunities
// in another currency are left out of the sums and counted, and the screen says how many.
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export interface PipelineSummary {
  /** The currency the money figures are in, and how many opportunities are in another one. */
  currency: string;
  other_currencies: number;
  /** Open opportunities, each counted at its stage's chance of being won. */
  weighted_pipeline: number;
  /** The weighted value of open opportunities made in the last thirty days. */
  weighted_added_30d: number;
  open_count: number;
  /** Open opportunities that a reply opened. */
  open_from_replies: number;
  /** Won this calendar quarter. */
  won_quarter: number;
  won_quarter_count: number;
  quarter_start: string;
  /** Mean value of opportunities won in the last twelve months that have a value. Null when there are none. */
  average_deal_size: number | null;
  /** Mean days from made to won, over the same twelve months. */
  sales_cycle_days: number | null;
  /** Won as a share of won and lost, over the same twelve months. Null when nothing has closed. */
  win_rate: number | null;
  closed_12m: number;
}

/** The first day of the calendar quarter `now` is in, as a UTC date ("2026-10-01"). */
export function quarterStart(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
}

/** The pipeline's figures for a workspace, or for one owner's opportunities (`none` for those nobody owns). */
export function pipelineSummary(db: DB, workspaceId: string, opts: { ownerId?: string | null; now?: Date } = {}): PipelineSummary {
  const now = opts.now ?? new Date();
  const owned = !opts.ownerId ? "" : opts.ownerId === "none" ? "AND o.owner_id IS NULL" : "AND o.owner_id = @owner";
  const ownerParam = opts.ownerId && opts.ownerId !== "none" ? { owner: opts.ownerId } : {};
  const currencies = db.prepare(`SELECT o.currency, COUNT(*) AS n FROM opportunities o WHERE o.workspace_id = @ws ${owned} GROUP BY o.currency ORDER BY n DESC, o.currency`).all({ ws: workspaceId, ...ownerParam }) as Array<{ currency: string; n: number }>;
  const currency = currencies[0]?.currency ?? "USD";
  const quarter = quarterStart(now);
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN open THEN amount * probability / 100.0 END), 0) AS weighted_pipeline,
      COALESCE(SUM(CASE WHEN open AND datetime(created_at) >= datetime(@monthAgo) THEN amount * probability / 100.0 END), 0) AS weighted_added_30d,
      COALESCE(SUM(CASE WHEN is_won AND date(closed_at) >= @quarter THEN amount END), 0) AS won_quarter,
      AVG(CASE WHEN is_won AND datetime(closed_at) >= datetime(@yearAgo) AND amount > 0 THEN amount END) AS average_deal_size
    FROM (
      SELECT COALESCE(o.amount, 0) AS amount, o.created_at, o.closed_at, COALESCE(ps.probability, 0) AS probability,
        COALESCE(ps.is_won, 0) AS is_won, COALESCE(ps.is_won, 0) = 0 AND COALESCE(ps.is_lost, 0) = 0 AS open
      FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
      WHERE o.workspace_id = @ws AND o.currency = @currency ${owned}
    )`).get({ ws: workspaceId, currency, quarter, yearAgo, monthAgo, ...ownerParam }) as {
      weighted_pipeline: number; weighted_added_30d: number; won_quarter: number; average_deal_size: number | null;
    };

  // Counts are of opportunities, whatever currency they are in.
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN COALESCE(ps.is_won, 0) = 0 AND COALESCE(ps.is_lost, 0) = 0 THEN 1 ELSE 0 END), 0) AS open_count,
      COALESCE(SUM(CASE WHEN COALESCE(ps.is_won, 0) = 0 AND COALESCE(ps.is_lost, 0) = 0 AND o.source = 'reply' THEN 1 ELSE 0 END), 0) AS open_from_replies,
      COALESCE(SUM(CASE WHEN ps.is_won = 1 AND date(o.closed_at) >= @quarter THEN 1 ELSE 0 END), 0) AS won_quarter_count,
      COALESCE(SUM(CASE WHEN ps.is_won = 1 AND datetime(o.closed_at) >= datetime(@yearAgo) THEN 1 ELSE 0 END), 0) AS won_12m,
      COALESCE(SUM(CASE WHEN ps.is_lost = 1 AND datetime(o.closed_at) >= datetime(@yearAgo) THEN 1 ELSE 0 END), 0) AS lost_12m,
      AVG(CASE WHEN ps.is_won = 1 AND datetime(o.closed_at) >= datetime(@yearAgo) THEN julianday(o.closed_at) - julianday(o.created_at) END) AS cycle
    FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
    WHERE o.workspace_id = @ws ${owned}`).get({ ws: workspaceId, quarter, yearAgo, ...ownerParam }) as {
      open_count: number; open_from_replies: number; won_quarter_count: number; won_12m: number; lost_12m: number; cycle: number | null;
    };

  const closed = counts.won_12m + counts.lost_12m;
  return {
    currency,
    other_currencies: currencies.slice(1).reduce((sum, item) => sum + item.n, 0),
    weighted_pipeline: Math.round(row.weighted_pipeline),
    weighted_added_30d: Math.round(row.weighted_added_30d),
    open_count: counts.open_count,
    open_from_replies: counts.open_from_replies,
    won_quarter: Math.round(row.won_quarter),
    won_quarter_count: counts.won_quarter_count,
    quarter_start: quarter,
    average_deal_size: row.average_deal_size === null ? null : Math.round(row.average_deal_size),
    sales_cycle_days: counts.cycle === null ? null : Math.max(0, Math.round(counts.cycle)),
    win_rate: closed ? counts.won_12m / closed : null,
    closed_12m: closed,
  };
}
