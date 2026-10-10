import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";

type DB = DatabaseType.Database;

/**
 * On/off choices a workspace admin makes, with what each one is until somebody changes it.
 *
 * warmup_shared_pool: warmup mail is exchanged with other workspaces' mailboxes on this
 * instance, which shows each side the other's sending address. Off keeps warmup between
 * the workspace's own mailboxes.
 */
export const WORKSPACE_SWITCHES = { warmup_shared_pool: true } as const;
export type WorkspaceSwitch = keyof typeof WORKSPACE_SWITCHES;

export function isWorkspaceSwitch(key: string): key is WorkspaceSwitch {
  return Object.prototype.hasOwnProperty.call(WORKSPACE_SWITCHES, key);
}

export function getWorkspaceSetting(workspaceId: string, key: string, db: DB = getDb()): string | null {
  const row = db.prepare("SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?").get(workspaceId, key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setWorkspaceSetting(workspaceId: string, key: string, value: string, db: DB = getDb()): void {
  db.prepare(`INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(workspaceId, key, value);
}

export function getWorkspaceSwitch(workspaceId: string, key: WorkspaceSwitch, db: DB = getDb()): boolean {
  const value = getWorkspaceSetting(workspaceId, key, db);
  return value === null ? WORKSPACE_SWITCHES[key] : value === "1";
}

export function getWorkspaceSwitches(workspaceId: string, db: DB = getDb()): Record<WorkspaceSwitch, boolean> {
  const keys = Object.keys(WORKSPACE_SWITCHES) as WorkspaceSwitch[];
  return Object.fromEntries(keys.map((key) => [key, getWorkspaceSwitch(workspaceId, key, db)])) as Record<WorkspaceSwitch, boolean>;
}

export function setWorkspaceSwitch(workspaceId: string, key: WorkspaceSwitch, on: boolean, db: DB = getDb()): void {
  setWorkspaceSetting(workspaceId, key, on ? "1" : "0", db);
}

/** A user's own settings whose key starts with `prefix`, as { key-without-prefix: value }. */
export function getUserSettings(userId: string, prefix: string, db: DB = getDb()): Record<string, string | null> {
  const rows = db.prepare("SELECT key, value FROM user_settings WHERE user_id = ? AND substr(key, 1, ?) = ?")
    .all(userId, prefix.length, prefix) as Array<{ key: string; value: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.key.slice(prefix.length), row.value]));
}

export function setUserSetting(userId: string, key: string, value: string, db: DB = getDb()): void {
  db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(userId, key, value);
}
