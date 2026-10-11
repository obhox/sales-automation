// The shape of the database.
//
// runMigrations() applies each statement inside a try/catch that ignores every error (so
// that "duplicate column" on a second start is harmless). The cost is that a migration
// with a typo, or one that names a column that does not exist yet, fails without a sound
// and the app starts on a database that is missing something. These tests are the sound.
//
//  1. A database upgraded from the last release ends up with the same tables, columns and
//     indexes as a brand-new install. A column that exists only in a CREATE TABLE, or only
//     as an ALTER, shows up here.
//  2. The result matches a checked-in description, so every schema change is a visible
//     line in a diff. After an intended change, refresh it with:
//         UPDATE_SCHEMA_SNAPSHOT=1 npx vitest run tests/schema.test.ts
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db";
import { describeSchema, type SchemaShape } from "./helpers/schema";

const FIXTURES = path.join(__dirname, "fixtures", "schema");
const SNAPSHOT = path.join(FIXTURES, "current.json");
// A new install as of the release production runs today (28ad7b0, 10 October 2026).
const LAST_RELEASE = path.join(FIXTURES, "release-2026-10-10.sql");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-schema-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function open(name: string): Database.Database {
  const db = new Database(path.join(dir, name));
  db.pragma("foreign_keys = ON");
  return db;
}

const fresh = open("fresh.db");
migrateDatabase(fresh);
const freshShape = describeSchema(fresh);

const upgraded = open("upgraded.db");
upgraded.exec(fs.readFileSync(LAST_RELEASE, "utf8"));
const releaseShape = describeSchema(upgraded);
migrateDatabase(upgraded);
const upgradedShape = describeSchema(upgraded);

// What production actually looks like: the last release, started more than once. Every
// start after the first used to put three dead columns back on run_profiles.
const restarted = open("restarted.db");
restarted.exec(fs.readFileSync(LAST_RELEASE, "utf8"));
for (const column of ["last_email_subject", "last_email_body", "last_linkedin_message"]) restarted.exec(`ALTER TABLE run_profiles ADD COLUMN ${column} TEXT`);
restarted.exec("CREATE INDEX IF NOT EXISTS idx_targets_linkedin_profile_id ON targets(workspace_id, linkedin_profile_id)");
migrateDatabase(restarted);
const restartedShape = describeSchema(restarted);

/** Lines present in one description and not the other, as "table: line". */
function difference(a: SchemaShape, b: SchemaShape, part: "columns" | "indexes"): string[] {
  const out: string[] = [];
  for (const table of Object.keys(a)) {
    const other = new Set(b[table]?.[part] ?? []);
    for (const line of a[table][part]) if (!other.has(line)) out.push(`${table}: ${line}`);
  }
  return out;
}

describe("a database upgraded from the last release", () => {
  it("starts from a real earlier schema, not from the current one", () => {
    expect(Object.keys(releaseShape).length).toBeGreaterThan(40);
    expect(releaseShape.workflows).toBeDefined();
    expect(releaseShape.saved_views).toBeUndefined();
  });

  it("has every table a new install has, and no others", () => {
    expect(Object.keys(upgradedShape).sort()).toEqual(Object.keys(freshShape).sort());
  });

  it("has every column a new install has, with the same type, default and constraints", () => {
    expect(difference(freshShape, upgradedShape, "columns")).toEqual([]);
    expect(difference(upgradedShape, freshShape, "columns")).toEqual([]);
  });

  it("has the same indexes", () => {
    expect(difference(freshShape, upgradedShape, "indexes")).toEqual([]);
    expect(difference(upgradedShape, freshShape, "indexes")).toEqual([]);
  });

  it("ends up the same when the old code had already been restarted on it", () => {
    expect(restartedShape).toEqual(freshShape);
  });

  it("keeps the dead run_profiles columns if, against expectation, they hold something", () => {
    const odd = open("odd.db");
    odd.exec(fs.readFileSync(LAST_RELEASE, "utf8"));
    odd.exec("ALTER TABLE run_profiles ADD COLUMN last_email_body TEXT");
    odd.exec("INSERT INTO run_profiles (id, last_email_body) VALUES ('rp-odd', 'kept')");
    migrateDatabase(odd);
    expect(odd.prepare("SELECT last_email_body FROM run_profiles WHERE id = 'rp-odd'").get()).toEqual({ last_email_body: "kept" });
    odd.close();
  });

  it("is left unchanged by a second start", () => {
    migrateDatabase(upgraded);
    expect(describeSchema(upgraded)).toEqual(upgradedShape);
    migrateDatabase(fresh);
    expect(describeSchema(fresh)).toEqual(freshShape);
  });
});

describe("the schema of a new install", () => {
  it("matches the checked-in description", () => {
    if (process.env.UPDATE_SCHEMA_SNAPSHOT) {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(freshShape, null, 2) + "\n");
    }
    const recorded = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as SchemaShape;
    expect(difference(freshShape, recorded, "columns"), "columns the code creates that the snapshot does not list").toEqual([]);
    expect(difference(recorded, freshShape, "columns"), "columns the snapshot lists that the code no longer creates").toEqual([]);
    expect(difference(freshShape, recorded, "indexes"), "indexes the code creates that the snapshot does not list").toEqual([]);
    expect(difference(recorded, freshShape, "indexes"), "indexes the snapshot lists that the code no longer creates").toEqual([]);
    expect(Object.keys(freshShape).sort()).toEqual(Object.keys(recorded).sort());
  });
});
