// The copy taken before a one-time change that rewrites rows.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, migrateDatabase, snapshotBefore } from "@/lib/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-snapshot-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("copying the database before a one-time repair", () => {
  it("is not done when there is nothing a repair could damage", () => {
    const fresh = new Database(path.join(dir, "fresh.db"));
    fresh.exec("CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT)");
    expect(snapshotBefore(fresh, "company-repair", dir)).toBeNull();
    expect(snapshotBefore(new Database(":memory:"), "company-repair", dir)).toBeNull();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([]);
  });

  it("writes a complete database the app could open, beside the original", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-snap', 'ws-snap', 'ws-snap')").run();
    db.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('snap-co-1', 'ws-snap', 'Acme'), ('snap-co-2', 'ws-snap', 'Globex')").run();
    const copy = snapshotBefore(db, "company-repair", dir);
    expect(copy).toMatch(/\.before-company-repair-\d{8}T\d{6}\.bak$/);
    const opened = new Database(String(copy), { readonly: true });
    expect(opened.prepare("SELECT name FROM companies WHERE id LIKE 'snap-co-%' ORDER BY name").all()).toEqual([{ name: "Acme" }, { name: "Globex" }]);
    expect((opened.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c)
      .toBe((db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c);
    opened.close();
    // What happens to the original afterwards is not in the copy.
    db.prepare("DELETE FROM companies WHERE id = 'snap-co-1'").run();
    const again = new Database(String(copy), { readonly: true });
    expect(again.prepare("SELECT COUNT(*) c FROM companies WHERE id LIKE 'snap-co-%'").get()).toEqual({ c: 2 });
    again.close();
  });

  it("says no, rather than letting the repair go ahead, when the copy cannot be written", () => {
    expect(snapshotBefore(getDb(), "company-repair", path.join(dir, "no-such-folder"))).toBe(false);
  });
});

describe("copying the database before the interface rebuild's changes", () => {
  const copies = (folder: string) => fs.readdirSync(folder).filter((name) => name.includes(".before-ui-rebuild-"));
  const flagged = (db: Database.Database) => Boolean(db.prepare("SELECT 1 FROM _migration_flags WHERE key = 'copy_before_ui_rebuild_v1'").get());

  it("keeps a database from the previous release as it was, once", () => {
    const folder = fs.mkdtempSync(path.join(dir, "upgrade-"));
    const file = path.join(folder, "linki.db");
    // A database the previous release has already run on: migrated, with data in it,
    // and without the mark that says the copy was made.
    const db = new Database(file);
    migrateDatabase(db);
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-up', 'ws-up', 'ws-up')").run();
    db.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('up-co', 'ws-up', 'Acme')").run();
    db.prepare("DELETE FROM _migration_flags WHERE key = 'copy_before_ui_rebuild_v1'").run();
    db.exec("ALTER TABLE targets DROP COLUMN linkedin_account_id");

    migrateDatabase(db);

    expect(flagged(db)).toBe(true);
    expect(copies(folder)).toHaveLength(1);
    // The copy is the database before this start's changes: it has the data and not the new column.
    const copy = new Database(path.join(folder, copies(folder)[0]), { readonly: true });
    expect(copy.prepare("SELECT name FROM companies").all()).toEqual([{ name: "Acme" }]);
    expect((copy.prepare("SELECT name FROM pragma_table_info('targets')").all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("linkedin_account_id");
    copy.close();
    expect((db.prepare("SELECT name FROM pragma_table_info('targets')").all() as Array<{ name: string }>).map((column) => column.name)).toContain("linkedin_account_id");

    // Starting again makes no second copy.
    migrateDatabase(db);
    expect(copies(folder)).toHaveLength(1);
    db.close();
  });

  it("has nothing to keep on a new database, and never copies it later", () => {
    const folder = fs.mkdtempSync(path.join(dir, "new-"));
    const db = new Database(path.join(folder, "linki.db"));
    migrateDatabase(db);
    expect(flagged(db)).toBe(true);
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-new', 'ws-new', 'ws-new')").run();
    db.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('new-co', 'ws-new', 'Acme')").run();
    migrateDatabase(db);
    expect(copies(folder)).toEqual([]);
    db.close();
  });
});
