import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { syncConnection } from "@/lib/platform/connectors";
import { connectionUrlProblem } from "@/lib/platform/safe-fetch";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export const CONNECTION_PROVIDERS = ["hubspot", "salesforce", "google_calendar", "microsoft_calendar", "ical"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
const PROVIDERS = new Set<string>(CONNECTION_PROVIDERS);

export interface ConnectionRow {
  id: string;
  provider: ConnectionProvider;
  name: string;
  /** The settings a person chose, as JSON. Never the token, and a private calendar address is cut to its host. */
  config_json: string;
  enabled: number;
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  sync_record_count: number;
}

// The settings each provider takes. Anything else in the stored JSON is the sync's own
// bookkeeping (where it got to), which is not sent back.
export const CONNECTION_SETTINGS: Record<ConnectionProvider, string[]> = {
  hubspot: [],
  salesforce: ["instance_url", "api_version", "external_id_field"],
  google_calendar: ["calendar_id"],
  microsoft_calendar: [],
  ical: ["url"],
};

function parse(json: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A private calendar address is a credential: whoever has it can read the calendar. Only where it points is sent back. */
function hostOnly(url: unknown): string {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "";
  }
}

function shownConfig(provider: string, json: string | null): Record<string, unknown> {
  const stored = parse(json);
  const shown: Record<string, unknown> = {};
  for (const key of CONNECTION_SETTINGS[provider as ConnectionProvider] ?? []) {
    if (stored[key] === undefined || stored[key] === null || stored[key] === "") continue;
    shown[key] = provider === "ical" && key === "url" ? hostOnly(stored[key]) : stored[key];
  }
  return shown;
}

const settingText = (config: Record<string, unknown>, key: string) => (typeof config[key] === "string" ? (config[key] as string).trim() : "");

/**
 * Why a sync may not be pointed at the address in these settings, or null when it may.
 * The server fetches a calendar feed's address and posts to a Salesforce instance's, so
 * neither may lead back inside the network this instance runs on. Looks the name up.
 */
async function addressProblem(provider: string, config: Record<string, unknown>): Promise<string | null> {
  if (provider === "salesforce" && settingText(config, "instance_url")) return connectionUrlProblem(settingText(config, "instance_url"));
  if (provider === "ical" && settingText(config, "url")) return connectionUrlProblem(settingText(config, "url"), { allowHttp: true });
  return null;
}

/** Why these settings will not work for this provider, or null when they will. */
async function configProblem(provider: string, config: Record<string, unknown>): Promise<string | null> {
  if (provider === "salesforce") {
    if (!/^https:\/\/[^\s/]+/.test(settingText(config, "instance_url"))) return "Salesforce needs its instance URL, starting with https://";
    if (!settingText(config, "external_id_field")) return "Salesforce needs the name of an External ID field on Contact";
  }
  if (provider === "ical" && !/^https?:\/\/[^\s/]+/.test(settingText(config, "url"))) return "A calendar feed needs its address, starting with https://";
  return addressProblem(provider, config);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const rows = db.prepare(`SELECT ec.id, ec.provider, ec.name, ec.config_json, ec.enabled, ec.last_synced_at, ec.sync_error, ec.created_at,
      COUNT(esr.id) sync_record_count FROM external_connections ec LEFT JOIN external_sync_records esr ON esr.connection_id = ec.id
      WHERE ec.workspace_id = ? GROUP BY ec.id ORDER BY ec.created_at DESC, ec.rowid DESC`).all(ctx.workspaceId) as ConnectionRow[];
    return res.json(rows.map((row) => ({ ...row, config_json: JSON.stringify(shownConfig(row.provider, row.config_json)) })));
  }
  if (req.method === "POST") {
    const { provider, name, config = {}, secret } = req.body as { provider?: string; name?: string; config?: unknown; secret?: string };
    if (!provider || !PROVIDERS.has(provider) || !name) return res.status(400).json({ error: "Valid provider and name are required" });
    if (provider !== "ical" && !secret) return res.status(400).json({ error: "An access token or private app token is required" });
    const settings = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
    const problem = await configProblem(provider, settings);
    if (problem) return res.status(400).json({ error: problem });
    const id = randomUUID();
    db.prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, provider, name, JSON.stringify(settings), secret ? encryptSecret(secret) : null);
    recordAudit(ctx, "connection.created", "external_connection", id, { provider, name });
    return res.status(201).json({ id, provider, name });
  }
  if (req.method === "PUT") {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ error: "id is required" });
    try {
      const result = await syncConnection(id, ctx.workspaceId);
      recordAudit(ctx, "connection.synced", "external_connection", id, result);
      return res.json(result);
    } catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  }
  if (req.method === "PATCH") {
    const { id, enabled, name, config, config_merge, secret } = req.body as { id?: string; enabled?: boolean; name?: string; config?: unknown; config_merge?: unknown; secret?: string };
    if (!id) return res.status(400).json({ error: "id is required" });
    // `config` replaces the stored settings, as it always has. `config_merge` changes only the
    // settings it names, so the sync's own bookkeeping in the same JSON is kept.
    let merged: string | null = null;
    if (config === undefined && config_merge && typeof config_merge === "object" && !Array.isArray(config_merge)) {
      const row = db.prepare("SELECT provider, config_json FROM external_connections WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as { provider: string; config_json: string } | undefined;
      if (!row) return res.status(404).json({ error: "Connection not found" });
      const next = parse(row.config_json);
      for (const [key, value] of Object.entries(config_merge as Record<string, unknown>)) {
        if (!(CONNECTION_SETTINGS[row.provider as ConnectionProvider] ?? []).includes(key)) continue;
        if (value === null || value === "") delete next[key];
        else next[key] = value;
      }
      const problem = await configProblem(row.provider, next);
      if (problem) return res.status(400).json({ error: problem });
      merged = JSON.stringify(next);
    } else if (config && typeof config === "object" && !Array.isArray(config)) {
      // Replacing every setting is not otherwise checked, as it never was. Where it would be
      // pointed is: the sync would refuse that address anyway, and saying so now is kinder.
      const row = db.prepare("SELECT provider FROM external_connections WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as { provider: string } | undefined;
      const problem = row ? await addressProblem(row.provider, config as Record<string, unknown>) : null;
      if (problem) return res.status(400).json({ error: problem });
    }
    db.prepare(`UPDATE external_connections SET name=COALESCE(?,name), config_json=COALESCE(?,config_json),
      secret_value=COALESCE(?,secret_value), enabled=COALESCE(?,enabled) WHERE id=? AND workspace_id=?`)
      .run(name ?? null, config === undefined ? merged : JSON.stringify(config), secret ? encryptSecret(secret) : null, enabled === undefined ? null : enabled ? 1 : 0, id, ctx.workspaceId);
    recordAudit(ctx, "connection.updated", "external_connection", id, enabled === undefined ? undefined : { enabled });
    return res.json({ ok: true });
  }
  if (req.method === "DELETE") {
    const id = String(req.query.id ?? "");
    db.prepare("DELETE FROM external_connections WHERE id=? AND workspace_id=?").run(id, ctx.workspaceId);
    recordAudit(ctx, "connection.deleted", "external_connection", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
