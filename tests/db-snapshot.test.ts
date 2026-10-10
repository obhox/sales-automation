// The copy taken before a one-time change that rewrites rows.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, snapshotBefore } from "@/lib/db";

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
