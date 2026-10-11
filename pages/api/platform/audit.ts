import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { AUDIT_KEEP_MONTHS, auditSourceCounts, countAudit, isAuditSource, listAudit, listAuditRows, type AuditEntry, type AuditFilter, type AuditSource } from "@/lib/audit";
import { sendCsv, type CsvColumn } from "@/lib/export/csv";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// The workspace's audit log, for admins.
//
//   GET                         the newest entries as an array of rows (what the MCP tool reads)
//   GET ?view=list              a page of entries with names, a total and counts per source
//   GET ?format=csv             the matching entries as a file
// All three take: source (web, api, mcp), q, user_id, from, to (YYYY-MM-DD).

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  page: number;
  page_size: number;
  /** Entries per source, before any other filter. */
  counts: Record<"all" | AuditSource, number>;
  keep_months: number;
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

const CSV_COLUMNS: CsvColumn<AuditEntry>[] = [
  { header: "Time (UTC)", value: (entry) => entry.created_at },
  { header: "Who", value: (entry) => entry.actor?.name ?? "" },
  { header: "Email", value: (entry) => entry.actor?.email ?? "" },
  { header: "Action", value: (entry) => entry.action },
  { header: "What", value: (entry) => entry.entity_type ?? "" },
  { header: "Name", value: (entry) => entry.entity_label ?? "" },
  { header: "Id", value: (entry) => entry.entity_id ?? "" },
  { header: "Source", value: (entry) => entry.source ?? "" },
  { header: "Through", value: (entry) => entry.via ?? "" },
  { header: "IP address", value: (entry) => entry.ip_address ?? "" },
  { header: "Details", value: (entry) => (entry.metadata ? JSON.stringify(entry.metadata) : "") },
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;
  const db = getDb();
  const source = one(req.query.source);
  const filter: AuditFilter = {
    source: isAuditSource(source) ? source : null,
    q: one(req.query.q) || null, userId: one(req.query.user_id) || null, from: one(req.query.from) || null, to: one(req.query.to) || null,
  };

  if (one(req.query.format) === "csv") {
    const sent = await sendCsv(res, `linki-audit-log-${new Date().toISOString().slice(0, 10)}`, CSV_COLUMNS, (limit, offset) => listAudit(db, ctx.workspaceId, filter, limit, offset));
    // Taking a copy of the log is itself something the log should show.
    recordAudit(ctx, "audit_log.downloaded", "workspace", ctx.workspaceId, { entries: sent, ...(filter.source ? { source: filter.source } : {}) });
    return;
  }

  if (one(req.query.view) === "list") {
    const pageSize = Math.min(Math.max(Number(one(req.query.limit)) || 25, 1), 100);
    const page = Math.max(Number(one(req.query.page)) || 1, 1);
    const payload: AuditPage = {
      entries: listAudit(db, ctx.workspaceId, filter, pageSize, (page - 1) * pageSize),
      total: countAudit(db, ctx.workspaceId, filter), page, page_size: pageSize,
      counts: auditSourceCounts(db, ctx.workspaceId), keep_months: AUDIT_KEEP_MONTHS,
    };
    return res.json(payload);
  }

  // The plain form: rows as they are stored, newest first.
  const limit = Math.min(Math.max(Number(one(req.query.limit)) || 100, 1), 500);
  return res.json(listAuditRows(db, ctx.workspaceId, filter, limit));
}
