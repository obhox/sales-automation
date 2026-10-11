// What a workspace has chosen about its pipeline.
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getWorkspaceSetting, setWorkspaceSetting } from "@/lib/workspace-settings";

type DB = DatabaseType.Database;

/**
 * A positive reply opens an opportunity for the contact, unless they already have one
 * open. Off unless switched on: a workspace that existed before this was added has no
 * value stored and keeps working as it did. A workspace made since starts with it on
 * (seedPipeline in lib/workspace.ts).
 */
export const AUTO_OPPORTUNITY_KEY = "auto_opportunity_on_reply";

export interface PipelineSettings { auto_opportunity_on_reply: boolean }

export function pipelineSettings(workspaceId: string, db: DB = getDb()): PipelineSettings {
  return { auto_opportunity_on_reply: getWorkspaceSetting(workspaceId, AUTO_OPPORTUNITY_KEY, db) === "1" };
}

export function setAutoOpportunity(workspaceId: string, on: boolean, db: DB = getDb()): void {
  setWorkspaceSetting(workspaceId, AUTO_OPPORTUNITY_KEY, on ? "1" : "0", db);
}
