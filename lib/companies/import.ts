// Companies from a CSV file: one row a company, matched to an existing company by its
// domain (or by its name when the row has no domain) so a second import updates, not doubles.
import Papa from "papaparse";
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { lookupDomain } from "@/lib/companies/enrich";

type DB = DatabaseType.Database;

/** The columns an import fills, and the headers each is known by. */
export const COMPANY_CSV_FIELDS = ["name", "domain", "website", "industry", "location", "linkedin_url", "notes"] as const;
type Field = (typeof COMPANY_CSV_FIELDS)[number];
const ALIASES: Record<string, Field> = {
  name: "name", company: "name", company_name: "name", account: "name", account_name: "name", organization: "name", organisation: "name",
  domain: "domain", company_domain: "domain", email_domain: "domain",
  website: "website", url: "website", company_website: "website", website_url: "website",
  industry: "industry", sector: "industry",
  location: "location", hq: "location", headquarters: "location", city: "location",
  linkedin_url: "linkedin_url", linkedin: "linkedin_url", company_linkedin: "linkedin_url", company_linkedin_url: "linkedin_url",
  notes: "notes", note: "notes", comment: "notes", comments: "notes",
};
export const MAX_COMPANY_ROWS = 5000;

export const companyCsvTemplate = () => `${COMPANY_CSV_FIELDS.join(",")}\nNorthwind Logistics,northwind.example,https://northwind.example,Freight & logistics,"Rotterdam, Netherlands",https://www.linkedin.com/company/northwind,Met at the spring conference\n`;

export interface CompanyImportResult {
  created: number;
  updated: number;
  /** Rows that matched a company and had nothing new to add. */
  unchanged: number;
  errors: string[];
  /** Headers that were not recognised and so were not imported. */
  ignored_columns: string[];
}

/**
 * Import companies. A row needs a name; a domain is taken from the domain column, or from
 * the website when there is none. On a match only empty fields are filled: what someone
 * typed, or an enrichment wrote, is never overwritten by a file.
 */
export function importCompanies(db: DB, workspaceId: string, csv: string): CompanyImportResult {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (header) => header.trim().toLowerCase().replace(/[\s-]+/g, "_") });
  const headers = parsed.meta.fields ?? [];
  const known = headers.filter((header) => ALIASES[header]);
  const result: CompanyImportResult = { created: 0, updated: 0, unchanged: 0, errors: [], ignored_columns: headers.filter((header) => header && !ALIASES[header]) };
  if (!known.some((header) => ALIASES[header] === "name")) {
    result.errors.push("The file needs a column for the company's name (name, company or account).");
    return result;
  }
  if (parsed.data.length > MAX_COMPANY_ROWS) {
    result.errors.push(`The file has ${parsed.data.length} rows; at most ${MAX_COMPANY_ROWS} are imported at once.`);
    return result;
  }

  const byDomain = db.prepare("SELECT * FROM companies WHERE workspace_id = ? AND lower(domain) = ?");
  const byName = db.prepare("SELECT * FROM companies WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND (domain IS NULL OR domain = '') ORDER BY created_at LIMIT 1");
  const insert = db.prepare("INSERT INTO companies (id, workspace_id, name, domain, website, industry, location, linkedin_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

  db.transaction(() => {
    parsed.data.forEach((raw, index) => {
      const row: Partial<Record<Field, string>> = {};
      // The first column that names a field wins, so "location" is not overwritten by "city".
      for (const header of known) {
        const field = ALIASES[header];
        const value = (raw[header] ?? "").trim();
        if (value && !row[field]) row[field] = value;
      }
      if (!row.name) {
        if (Object.keys(row).length > 0 && result.errors.length < 20) result.errors.push(`Row ${index + 2}: no company name`);
        return;
      }
      const domain = lookupDomain(row.domain) ?? lookupDomain(row.website);
      const existing = (domain ? byDomain.get(workspaceId, domain) : byName.get(workspaceId, row.name)) as Record<string, string | null> | undefined;
      if (!existing) {
        insert.run(randomUUID(), workspaceId, row.name, domain, row.website ?? null, row.industry ?? null, row.location ?? null, row.linkedin_url ?? null, row.notes ?? null);
        result.created += 1;
        return;
      }
      const fill = (["website", "industry", "location", "linkedin_url", "notes"] as const).filter((field) => row[field] && !existing[field]);
      if (fill.length === 0) { result.unchanged += 1; return; }
      db.prepare(`UPDATE companies SET ${fill.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`).run(...fill.map((field) => row[field]), existing.id);
      result.updated += 1;
    });
  })();
  return result;
}
