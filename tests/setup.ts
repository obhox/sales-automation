// Runs before each test file. Points the SQLite layer at a throwaway DB so tests
// never touch the real linki.db. lib/db reads LINKI_DB_PATH at import time, so this
// MUST run before any test imports @/lib/db (vitest guarantees setupFiles run first).
import os from "os";
import path from "path";
import fs from "fs";

process.env.NODE_ENV = "test";

const unique = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const dbPath = path.join(os.tmpdir(), `linki-test-${unique}.db`);

// Start from a clean slate; remove any stray WAL/SHM siblings too.
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(dbPath + suffix);
  } catch {
    /* not present - fine */
  }
}

process.env.LINKI_DB_PATH = dbPath;
