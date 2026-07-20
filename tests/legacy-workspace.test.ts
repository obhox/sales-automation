import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";

// The legacy workspace bootstrap used to run on every boot, adding EVERY user as an
// OWNER of one shared tenant. These tests pin the one-shot guard that stops that.

const LEGACY = "00000000-0000-4000-8000-000000000001";

// The exact statements from lib/db.ts, re-executed here to simulate a later boot.
const SEED_WORKSPACE = `INSERT OR IGNORE INTO workspaces (id, name, slug)
  SELECT '${LEGACY}', 'Legacy workspace', 'legacy-workspace'
  WHERE NOT EXISTS (SELECT 1 FROM _migration_flags WHERE key = 'legacy_workspace_seeded_v1')`;
const SEED_MEMBERS = `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
  SELECT '${LEGACY}', id, 'owner' FROM users
  WHERE NOT EXISTS (SELECT 1 FROM _migration_flags WHERE key = 'legacy_workspace_seeded_v1')`;

beforeAll(() => {
  getDb(); // runs initDb + runMigrations, which sets the flag
});

describe("legacy workspace bootstrap", () => {
  it("sets the one-shot flag during migration", () => {
    const flag = getDb()
      .prepare("SELECT key FROM _migration_flags WHERE key = 'legacy_workspace_seeded_v1'")
      .get();
    expect(flag).toBeTruthy();
  });

  it("does not enrol a newly signed-up user into the legacy workspace", () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
      .run("u-new-signup", "new-signup@example.com", "hash");

    db.exec(SEED_MEMBERS); // simulate the next boot

    const membership = db
      .prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .get(LEGACY, "u-new-signup");
    expect(membership).toBeUndefined();
  });

  it("does not recreate the legacy workspace once an operator deletes it", () => {
    const db = getDb();
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(LEGACY);

    db.exec(SEED_WORKSPACE); // simulate the next boot

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(LEGACY);
    expect(row).toBeUndefined();
  });
});
