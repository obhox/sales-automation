// Read a selection of companies' websites and record what changed since last time.
//
//   POST { dry_run: true, company_ids }   what reading these would cost
//   POST { company_ids }                  read at most SIGNAL_BATCH of them
//
// Each company is a schema extraction rather than a plain read, which costs five Firecrawl
// credits and gives numbers that can be compared with last week's instead of prose that
// cannot. A dry run reaches no provider and spends nothing.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ResearchRefused, researchConnected, researchKey } from "@/lib/research/providers";
import {
  MAX_SIGNAL_RUN, SIGNAL_BATCH, readCompanySignals, signalCandidates, signalCost, type SignalOutcome,
} from "@/lib/research/signals";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export { SIGNAL_BATCH };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();

  const asked = Array.isArray(req.body?.company_ids) ? [...new Set(req.body.company_ids.filter((id: unknown) => typeof id === "string"))] as string[] : null;
  if (!asked || asked.length === 0) return res.status(400).json({ error: "company_ids must be a non-empty array" });
  if (asked.length > MAX_SIGNAL_RUN) return res.status(400).json({ error: `Read at most ${MAX_SIGNAL_RUN} companies at a time` });

  const candidates = signalCandidates(db, ctx.workspaceId, asked);

  if (req.body?.dry_run === true) {
    const connected = researchConnected(db, ctx.workspaceId);
    return res.json({
      ...signalCost(db, ctx.workspaceId, candidates, asked.length),
      firecrawl_connected: connected.firecrawl,
    });
  }

  if (asked.length > SIGNAL_BATCH) return res.status(400).json({ error: `Send at most ${SIGNAL_BATCH} companies in one request` });

  // Schema extraction is Firecrawl's; TinyFish's free reader returns prose, which is not
  // something a snapshot can be compared from, so it is not a fallback here.
  const apiKey = researchKey(db, ctx.workspaceId, "firecrawl");
  if (!apiKey) return res.status(400).json({ error: "Connect Firecrawl under Integrations to read company websites for signals." });

  const result: Record<SignalOutcome, number> = { signals: 0, no_change: 0, baseline: 0, no_website: 0, unreadable: 0 };
  let detected = 0;
  let stopped: string | null = null;
  for (const candidate of candidates) {
    try {
      const read = await readCompanySignals(db, ctx.workspaceId, candidate, apiKey);
      result[read.outcome] += 1;
      detected += read.detected;
    } catch (error) {
      if (error instanceof ResearchRefused) { stopped = error.message; break; }
      result.unreadable += 1;
    }
  }

  const read = result.signals + result.no_change + result.baseline;
  if (read > 0) recordAudit(ctx, "companies.researched", "company", asked.length === 1 ? asked[0] : undefined, { ...result, detected, credits: read * 5 });
  if (stopped) return res.status(502).json({ error: stopped, ...result, detected });
  return res.json({ ...result, detected });
}
