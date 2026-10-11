import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { deliverabilityReport, parseRangeDays, type ReportRow } from "@/lib/email/deliverability-overview";
import { sendCsv, type CsvColumn } from "@/lib/export/csv";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const HEADINGS: Array<[string, string]> = [
  ["Domain", "domain"], ["Domain score", "domain_score"], ["SPF", "spf"], ["DKIM", "dkim"], ["DMARC", "dmarc"], ["MX", "mx"], ["DNS checked", "dns_checked_at"],
  ["Domain emails sent", "domain_emails_sent"], ["Domain bounce rate %", "domain_bounce_rate_percent"], ["Domain complaint rate %", "domain_complaint_rate_percent"],
  ["Placement copies checked", "placement_copies_checked"], ["Placement in inbox", "placement_in_inbox"], ["Placement in spam", "placement_in_spam"], ["Placement missing", "placement_missing"],
  ["Mailbox", "mailbox"], ["Provider", "provider"], ["Status", "status"], ["Sent today", "sent_today"], ["Limit today", "limit_today"], ["Daily limit", "daily_limit"],
  ["Ramp day", "ramp_day"], ["Ramp days", "ramp_days"], ["Reputation", "reputation"],
  ["Emails (30 days)", "emails_30d"], ["Bounces (30 days)", "bounces_30d"], ["Bounce rate % (30 days)", "bounce_rate_30d_percent"],
  ["Complaints (30 days)", "complaints_30d"], ["Complaint rate % (30 days)", "complaint_rate_30d_percent"],
  ["Warm-up", "warmup"], ["Warm-up sent (7 days)", "warmup_sent_7d"], ["Warm-up rescued (7 days)", "warmup_rescued_7d"],
];
const COLUMNS: CsvColumn<ReportRow>[] = HEADINGS.map(([header, field]) => ({ header, value: (row) => row[field] }));

/**
 * GET ?range=&domain= : the deliverability report as a CSV file, a row per mailbox with
 * its domain's figures beside its own. `range` (7, 30 or 90 days) applies to the domain's
 * figures; a mailbox's own are always its last 30 days, which is what its guard goes by.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const range = parseRangeDays(req.query.range);
  const domain = typeof req.query.domain === "string" && req.query.domain ? req.query.domain.toLowerCase() : null;
  const rows = deliverabilityReport(getDb(), ctx.workspaceId, range, domain);
  // Recorded before the first byte leaves, as every export is. The file holds what the
  // screen shows a viewer, mailbox by mailbox, and no contact's data.
  recordAudit(ctx, "export.created", "export", undefined, { resource: "deliverability", rows: rows.length, range, domain });
  await sendCsv(res, `linki-deliverability-${domain ?? "all-domains"}-${range}d-${new Date().toISOString().slice(0, 10)}`, COLUMNS, (limit, offset) => rows.slice(offset, offset + limit));
}
