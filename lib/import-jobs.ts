import type DatabaseType from "better-sqlite3";
import { emitDomainEvent } from "@/lib/platform/events";
import { notify } from "@/lib/platform/notifications";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { getWorkspaceSetting, setWorkspaceSetting } from "@/lib/workspace-settings";

type DB = DatabaseType.Database;

const PAGE_SIZE = 25;
export const DEFAULT_DAILY_CAP = 1500;

export interface ImportRow {
  id: string;
  list_id: string;
  account_id: string | null;
  sales_nav_url: string | null;
  status: string;
  phase: string | null;
  page: number;
  total_pages: number;
  count: number;
  total: number;
  imported: number;
  skipped: number;
  error: string | null;
  scheduled_for: string | null;
  start_page: number;
  cap: number | null;
  cancel_requested: number;
  batch_index: number;
  enrich: number;
  started_at: string;
  finished_at: string | null;
}

// ─── settings ────────────────────────────────────────────────────────────────

// The cap and the budget it limits belong to one workspace: its admins set it, and it
// counts only that workspace's imports.

export function getDailyImportCap(db: DB, workspaceId: string): number {
  const n = parseInt(getWorkspaceSetting(workspaceId, "daily_import_cap", db) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

export function setDailyImportCap(db: DB, workspaceId: string, n: number): void {
  setWorkspaceSetting(workspaceId, "daily_import_cap", String(Math.max(1, Math.floor(n))), db);
}

// ─── quota ───────────────────────────────────────────────────────────────────

/** Contacts imported across all of a workspace's lists today (its daily budget). */
export function importedToday(db: DB, workspaceId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(li.imported), 0) c FROM list_imports li JOIN lists l ON l.id = li.list_id
       WHERE l.workspace_id = ? AND li.status IN ('done', 'running')
         AND date(COALESCE(li.finished_at, li.started_at)) = date('now')`
    )
    .get(workspaceId) as { c: number };
  return row.c;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(base: string, days: number): string {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Queue an import for a list. Creates the first batch as 'scheduled' for today;
 * the runner's scheduler picks it up (one import at a time). Large lists are
 * split across days under the daily cap by runBatch chaining continuations.
 */
export function startImport(
  db: DB,
  opts: { listId: string; accountId: string; salesNavUrl: string; enrich?: boolean }
): { importId: string } {
  cancelImportsForList(db, opts.listId); // supersede any prior import for this list
  const importId = randomUUID();
  db.prepare(
    `INSERT INTO list_imports
       (id, list_id, account_id, sales_nav_url, status, scheduled_for, start_page, batch_index, enrich, started_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, 1, 1, ?, datetime('now'))`
  ).run(importId, opts.listId, opts.accountId, opts.salesNavUrl, todayStr(), opts.enrich ? 1 : 0);
  return { importId };
}

export function cancelImportsForList(db: DB, listId: string): void {
  db.prepare(
    `UPDATE list_imports
       SET cancel_requested = 1,
           status = CASE WHEN status = 'scheduled' THEN 'canceled' ELSE status END,
           finished_at = CASE WHEN status = 'scheduled' THEN datetime('now') ELSE finished_at END
     WHERE list_id = ? AND status IN ('scheduled', 'running')`
  ).run(listId);
}

export function cancelImport(db: DB, importId: string): void {
  db.prepare(
    `UPDATE list_imports
       SET cancel_requested = 1,
           status = CASE WHEN status = 'scheduled' THEN 'canceled' ELSE status END,
           finished_at = CASE WHEN status = 'scheduled' THEN datetime('now') ELSE finished_at END
     WHERE id = ?`
  ).run(importId);
}

// ─── scheduler + executor ────────────────────────────────────────────────────

let importRunning = false;

/** Runner hook (called each tick): start the next due batch if none is running. */
export async function processScheduledImports(db: DB): Promise<void> {
  if (importRunning) return;
  const due = db
    .prepare(
      `SELECT * FROM list_imports
       WHERE status = 'scheduled' AND cancel_requested = 0
         AND (scheduled_for IS NULL OR scheduled_for <= date('now'))
       ORDER BY scheduled_for ASC, batch_index ASC LIMIT 1`
    )
    .get() as ImportRow | undefined;
  if (!due) return;

  importRunning = true;
  db.prepare("UPDATE list_imports SET status = 'running', started_at = datetime('now') WHERE id = ?").run(due.id);
  runBatch(due.id)
    .catch((e) => console.error("[import] batch crashed:", e))
    .finally(() => { importRunning = false; });
}

async function runBatch(importId: string): Promise<void> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM list_imports WHERE id = ?").get(importId) as ImportRow | undefined;
  if (!job || !job.account_id || !job.sales_nav_url) return;

  // List deleted out from under us?
  const list = db.prepare("SELECT id, workspace_id FROM lists WHERE id = ?").get(job.list_id) as { id: string; workspace_id: string } | undefined;
  if (!list) {
    db.prepare("UPDATE list_imports SET status = 'canceled', finished_at = datetime('now') WHERE id = ?").run(importId);
    return;
  }

  // Today's remaining budget → max whole pages this run
  const cap = getDailyImportCap(db, list.workspace_id);
  const remaining = cap - importedToday(db, list.workspace_id);
  const maxPages = Math.floor(remaining / PAGE_SIZE);
  if (maxPages < 1) {
    db.prepare("UPDATE list_imports SET status = 'scheduled', scheduled_for = ? WHERE id = ?").run(
      addDaysStr(todayStr(), 1),
      importId
    );
    return;
  }

  console.log(`[import] batch ${importId} (b${job.batch_index}) start_page=${job.start_page} maxPages=${maxPages} cap=${cap}`);
  const { getSessionContext } = await import("@/lib/linkedin/session");
  const { scrapeNavigatorUrl } = await import("@/lib/linkedin/scraper");

  const updateProgress = db.prepare(
    "UPDATE list_imports SET phase = ?, page = ?, total_pages = ?, count = ?, total = ? WHERE id = ?"
  );
  const isCanceled = () => {
    const r = db.prepare("SELECT cancel_requested FROM list_imports WHERE id = ?").get(importId) as
      | { cancel_requested: number }
      | undefined;
    return !r || r.cancel_requested === 1; // row deleted (list cascade) or explicit cancel
  };

  try {
    const ctx = await getSessionContext(job.account_id);
    const { profiles, lastPage, knownTotal, exhausted } = await scrapeNavigatorUrl(ctx, job.sales_nav_url, {
      startPage: job.start_page,
      maxPages,
      onProgress: (p) => updateProgress.run(p.phase, p.page ?? 0, p.totalPages ?? 0, p.count, p.total, importId),
      isCanceled,
    });

    if (isCanceled()) {
      if (db.prepare("SELECT id FROM list_imports WHERE id = ?").get(importId)) {
        db.prepare("UPDATE list_imports SET status = 'canceled', finished_at = datetime('now') WHERE id = ?").run(importId);
      }
      return;
    }

    const { imported, skipped } = insertProfiles(db, job.list_id, profiles);
    console.log(`[import] batch ${importId} inserted ${imported} new, skipped ${skipped} (lastPage=${lastPage}, exhausted=${exhausted})`);

    db.prepare(
      `UPDATE list_imports
         SET status = 'done', imported = ?, skipped = ?, count = ?, total = ?, page = ?, total_pages = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(imported, skipped, profiles.length, knownTotal, lastPage, Math.ceil(knownTotal / PAGE_SIZE), importId);
    announceImportFinished(db, job.list_id, importId, imported, skipped);

    // More of the list left → chain the remainder to the next day
    if (!exhausted) {
      db.prepare(
        `INSERT INTO list_imports
           (id, list_id, account_id, sales_nav_url, status, scheduled_for, start_page, batch_index, enrich, total, total_pages, started_at)
         VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        randomUUID(),
        job.list_id,
        job.account_id,
        job.sales_nav_url,
        addDaysStr(todayStr(), 1),
        lastPage + 1,
        job.batch_index + 1,
        job.enrich,
        knownTotal,
        Math.ceil(knownTotal / PAGE_SIZE)
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[import] FAILED:", message);
    if (db.prepare("SELECT id FROM list_imports WHERE id = ?").get(importId)) {
      db.prepare("UPDATE list_imports SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").run(
        message,
        importId
      );
    }
    // A "no data intercepted / re-authentication" failure means the session died.
    if ((/re-authentication|No data intercepted/i.test(message) || (err instanceof Error && err.name === "SessionExpiredError")) && job.account_id) {
      try {
        const { markNeedsReauth } = await import("@/lib/linkedin/session");
        await markNeedsReauth(job.account_id);
      } catch { /* ignore */ }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertProfiles(db: DB, listId: string, profiles: any[]): { imported: number; skipped: number } {
  const workspaceId = (db.prepare("SELECT workspace_id FROM lists WHERE id = ?").get(listId) as { workspace_id: string } | undefined)?.workspace_id;
  if (!workspaceId) throw new Error("List workspace not found");
  const insertTarget = db.prepare(
    `INSERT INTO targets (
       id, workspace_id, linkedin_url, sales_nav_url, first_name, last_name, full_name,
       title, company, location, degree,
       object_urn, summary, open_link, company_industry, company_location,
       tenure_months, spotlight_badges
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL DO UPDATE SET
       sales_nav_url = excluded.sales_nav_url,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       full_name = excluded.full_name,
       title = excluded.title,
       company = excluded.company,
       location = excluded.location,
       degree = excluded.degree,
       object_urn = excluded.object_urn,
       summary = excluded.summary,
       open_link = excluded.open_link,
       company_industry = excluded.company_industry,
       company_location = excluded.company_location,
       tenure_months = excluded.tenure_months,
       spotlight_badges = excluded.spotlight_badges`
  );
  const insertLink = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");
  const findTarget = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND linkedin_url = ?");

  let imported = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const p of profiles) {
      const url = p.linkedinUrl ?? p.salesNavUrl;
      insertTarget.run(
        randomUUID(), workspaceId, url, p.salesNavUrl,
        p.firstName, p.lastName, p.fullName,
        p.title, p.company, p.location, p.degree,
        p.objectUrn, p.summary, p.openLink ? 1 : 0,
        p.companyIndustry, p.companyLocation,
        p.tenureMonths, p.spotlightBadges
      );
      const target = findTarget.get(workspaceId, url) as { id: string };
      const result = insertLink.run(listId, target.id);
      if (result.changes > 0) imported++;
      else skipped++;
    }
  })();
  return { imported, skipped };
}

/** Tell the workspace an import batch has landed: an event for webhooks and a notification for the bell. */
function announceImportFinished(db: ReturnType<typeof getDb>, listId: string, importId: string, imported: number, skipped: number) {
  try {
    const list = db.prepare("SELECT workspace_id, name FROM lists WHERE id = ?").get(listId) as { workspace_id: string | null; name: string } | undefined;
    if (!list?.workspace_id) return;
    emitDomainEvent({ workspaceId: list.workspace_id, type: "import.finished", entityType: "list", entityId: listId, payload: { import_id: importId, imported, skipped } });
    notify({
      workspaceId: list.workspace_id, kind: "import.finished", tone: "good",
      title: `Import into ${list.name} finished`,
      body: `${imported} new ${imported === 1 ? "contact" : "contacts"}${skipped ? `, ${skipped} already there` : ""}.`,
      link: `/lists/${listId}`, dedupeKey: `import-finished:${importId}`,
    });
  } catch (error) {
    console.warn("[import] could not announce a finished import:", error instanceof Error ? error.message : error);
  }
}
