import { describe, it, expect, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

// The fix has to reach databases that already exist, not just fresh ones. This drives the
// real startup path against a DB whose email_replies still has the old
// `target_id TEXT NOT NULL ... ON DELETE CASCADE` shape, and checks that the rebuild
// converts it in place without losing rows.
describe("email_replies rebuild on an existing database", () => {
  it("converts NOT NULL/CASCADE to nullable/SET NULL and keeps the stored replies", async () => {
    const dbPath = path.join(os.tmpdir(), `linki-migration-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

    // 1. Build a database at the current schema, then regress email_replies to the old shape
    //    and seed it — this stands in for a production DB from before the fix.
    {
      process.env.LINKI_DB_PATH = dbPath;
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE email_replies_legacy (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          from_email TEXT NOT NULL,
          subject TEXT,
          body_text TEXT NOT NULL,
          received_at TEXT NOT NULL,
          workspace_id TEXT REFERENCES workspaces(id),
          email_account_id TEXT REFERENCES email_accounts(id),
          message_id TEXT,
          inbox_status TEXT NOT NULL DEFAULT 'open',
          manually_edited INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        DROP TABLE email_replies;
        ALTER TABLE email_replies_legacy RENAME TO email_replies;
        PRAGMA foreign_keys = ON;
      `);
      db.prepare("INSERT INTO workspaces (id,name,slug) VALUES ('ws-mig','Mig','mig-slug')").run();
      db.prepare("INSERT INTO targets (id,workspace_id,email,full_name) VALUES ('tgt-mig','ws-mig','lead@mig.test','Lead')").run();
      db.prepare(
        "INSERT INTO email_replies (id,workspace_id,target_id,from_email,subject,body_text,received_at) VALUES ('rep-mig','ws-mig','tgt-mig','lead@mig.test','Re: hi','Interested','2026-08-13T00:12:24.000Z')",
      ).run();

      const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='email_replies'").get() as { sql: string };
      expect(/target_id\s+TEXT\s+NOT\s+NULL/i.test(before.sql)).toBe(true);
      db.close();
    }

    // 2. Re-opening the same file is exactly what the next deploy does: a fresh module
    //    registry means getDb() runs initDb + runMigrations again, and the rebuild fires.
    vi.resetModules();
    {
      process.env.LINKI_DB_PATH = dbPath;
      const { getDb } = await import("@/lib/db");
      getDb().close();
    }

    // 3. Verify against the migrated file directly.
    const check = new Database(dbPath, { readonly: false });
    const after = (check.prepare("SELECT sql FROM sqlite_master WHERE name='email_replies'").get() as { sql: string }).sql;
    expect(/target_id\s+TEXT\s+NOT\s+NULL/i.test(after)).toBe(false);
    expect(/target_id[^,]*ON DELETE SET NULL/i.test(after)).toBe(true);

    // The stored reply came through the rebuild intact and still points at its contact.
    const kept = check.prepare("SELECT target_id, body_text FROM email_replies WHERE id='rep-mig'").get() as { target_id: string; body_text: string };
    expect(kept.target_id).toBe("tgt-mig");
    expect(kept.body_text).toBe("Interested");

    // And deleting the contact now detaches the reply rather than destroying it.
    check.pragma("foreign_keys = ON");
    check.prepare("DELETE FROM targets WHERE id='tgt-mig'").run();
    const detached = check.prepare("SELECT target_id, body_text FROM email_replies WHERE id='rep-mig'").get() as { target_id: string | null; body_text: string } | undefined;
    expect(detached).toBeDefined();
    expect(detached!.target_id).toBeNull();
    expect(detached!.body_text).toBe("Interested");
    check.close();

    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch { /* fine */ } }
  }, 60_000);
});
