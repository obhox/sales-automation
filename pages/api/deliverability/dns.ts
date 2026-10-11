import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { domainDns } from "@/lib/email/deliverability-overview";
import { normaliseDomain } from "@/lib/email/dns";
import { setDomainSelector } from "@/lib/email/dns-changes";
import { mailboxIdsOnDomain } from "@/lib/email/domain-health";
import { checkDomainDeliverability } from "@/lib/platform/deliverability";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * POST { domain, selector? } : look a sending domain's DNS records up again now (admin).
 *
 * With `selector`, that DKIM selector is kept for the domain and tried first from now on;
 * an empty one forgets it. Only a domain one of the workspace's mailboxes sends from can
 * be checked here.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;
  const db = getDb();
  const domain = typeof req.body?.domain === "string" ? normaliseDomain(req.body.domain) : "";
  if (!domain || mailboxIdsOnDomain(db, ctx.workspaceId, domain).length === 0) return res.status(404).json({ error: "No mailbox in this workspace sends from that domain" });

  if (req.body.selector !== undefined) {
    if (req.body.selector !== null && typeof req.body.selector !== "string") return res.status(400).json({ error: "selector must be text" });
    const problem = setDomainSelector(db, ctx.workspaceId, domain, req.body.selector);
    if (problem) return res.status(400).json({ error: problem });
  }
  const result = await checkDomainDeliverability({ workspaceId: ctx.workspaceId, domain });
  recordAudit(ctx, "deliverability.checked", "domain", domain, { score: result.score, ...(req.body.selector !== undefined ? { selector: req.body.selector || null } : {}) });
  return res.json({ dns: domainDns(db, ctx.workspaceId, domain), changes: result.changes });
}
