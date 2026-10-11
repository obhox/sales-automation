// Adding a connection provider changes a CHECK constraint, which SQLite can only do by
// rebuilding the table. The schema snapshot compares columns and indexes, not constraints,
// so it cannot see whether that rebuild worked — these tests can.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db";

const LAST_RELEASE = path.join(__dirname, "fixtures", "schema", "release-2026-10-10.sql");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-provider-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function open(name: string): Database.Database {
  const db = new Database(path.join(dir, name));
  db.pragma("foreign_keys = ON");
  return db;
}

const constraintOf = (db: Database.Database) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_connections'").get() as { sql: string }).sql;

const addConnection = (db: Database.Database, id: string, provider: string) =>
  db.prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json) VALUES (?, 'w1', ?, ?, '{}')").run(id, provider, id);

describe("a new install", () => {
  it("accepts cal_com, and still refuses a provider that is not a provider", () => {
    const db = open("fresh.db");
    migrateDatabase(db);
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('w1','W','w')").run();
    expect(() => addConnection(db, "c1", "cal_com")).not.toThrow();
    expect(() => addConnection(db, "c2", "nonsense")).toThrow();
  });
});

describe("a database upgraded from the last release", () => {
  const db = open("upgraded.db");
  db.exec(fs.readFileSync(LAST_RELEASE, "utf8"));
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('w1','W','w')").run();
  addConnection(db, "feed-1", "ical");
  db.prepare("UPDATE external_connections SET last_synced_at = '2026-10-01 09:00:00', sync_error = 'earlier failure' WHERE id = 'feed-1'").run();
  const before = constraintOf(db);
  migrateDatabase(db);

  it("did not accept cal_com before the rebuild", () => {
    expect(before).not.toContain("cal_com");
  });

  it("accepts it afterwards", () => {
    expect(constraintOf(db)).toContain("cal_com");
    expect(() => addConnection(db, "cal-1", "cal_com")).not.toThrow();
  });

  it("keeps the constraint rather than dropping it to let anything through", () => {
    // The easy way to make a CHECK stop complaining is to lose it. This is the test that
    // would catch that.
    expect(() => addConnection(db, "bad-1", "nonsense")).toThrow();
  });

  it("carries existing connections across with every column intact", () => {
    // A rebuild copies rows by hand, so a column left out of the copy is silently blanked.
    expect(db.prepare("SELECT id, provider, name, enabled, last_synced_at, sync_error FROM external_connections WHERE id = 'feed-1'").get()).toEqual({
      id: "feed-1", provider: "ical", name: "feed-1", enabled: 1,
      last_synced_at: "2026-10-01 09:00:00", sync_error: "earlier failure",
    });
  });

  it("is a no-op when migrations run again, as they do on every start", () => {
    const rows = db.prepare("SELECT COUNT(*) AS c FROM external_connections").get() as { c: number };
    migrateDatabase(db);
    migrateDatabase(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM external_connections").get()).toEqual(rows);
    expect(constraintOf(db)).toContain("cal_com");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'external_connections_rebuilt'").get()).toBeUndefined();
  });
});
