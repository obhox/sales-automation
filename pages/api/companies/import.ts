import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { companyCsvTemplate, importCompanies } from "@/lib/companies/import";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// Companies from a CSV file.
//
//   GET                   the template, as a file
//   POST { csv }          import; a row matches an existing company by its domain, or by its name when it has none
//
// A match only fills fields that are empty, so a file never overwrites what is there.

export const config = { api: { bodyParser: { sizeLimit: "8mb" } } };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const ctx = requireWorkspace(req, res);
    if (!ctx) return;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="linki-companies-template.csv"');
    return res.send(companyCsvTemplate());
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const csv = (req.body ?? {}).csv;
  if (typeof csv !== "string" || !csv.trim()) return res.status(400).json({ error: "csv must be the text of a CSV file" });
  const result = importCompanies(getDb(), ctx.workspaceId, csv);
  if (result.created + result.updated > 0) recordAudit(ctx, "companies.imported", "company", undefined, { created: result.created, updated: result.updated });
  return res.status(result.created + result.updated + result.unchanged === 0 && result.errors.length > 0 ? 400 : 200).json(result);
}
