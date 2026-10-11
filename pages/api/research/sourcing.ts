// Find companies from a page that lists them.
//
//   POST { dry_run: true, url }        which provider the page calls for, and what it costs
//   POST { url, goal? }                read it and keep the companies not already known
//   POST { run_id }                    resume an agent run handed back earlier
//
// A static listing page is read by Firecrawl in one request. A page that needs a search or
// a sign-in is worked by a TinyFish agent, which takes tens of seconds: the request waits
// briefly and then hands back a run_id to poll, rather than holding open until a gateway
// times out and the steps are paid for with nothing to show.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ResearchRefused, researchConnected, researchKey } from "@/lib/research/providers";
import {
  keepSourced, planSourcing, resumeSourcing, sourceWithFirecrawl, sourceWithTinyfish,
} from "@/lib/research/sourcing";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const connected = researchConnected(db, ctx.workspaceId);

  // Resuming a run the caller was handed earlier. No plan and no cost: the steps were
  // already committed when it started.
  const runId = typeof req.body?.run_id === "string" ? req.body.run_id.trim() : "";
  if (runId) {
    const apiKey = researchKey(db, ctx.workspaceId, "tinyfish");
    if (!apiKey) return res.status(400).json({ error: "Connect TinyFish under Integrations to follow an agent run." });
    try {
      const state = await resumeSourcing(runId, apiKey);
      if (!state.done) return res.json({ done: false, run_id: state.run_id, status: state.status });
      const kept = keepSourced(db, ctx.workspaceId, state.companies);
      recordAudit(ctx, "companies.sourced", "company", undefined, { ...kept, found: state.companies.length, cost_usd: state.cost_usd, run_id: runId });
      return res.json({ done: true, found: state.companies.length, ...kept, cost_usd: state.cost_usd });
    } catch (error) {
      if (error instanceof ResearchRefused) return res.status(502).json({ error: error.message });
      throw error;
    }
  }

  const plan = planSourcing(typeof req.body?.url === "string" ? req.body.url : "");
  if (!plan) return res.status(400).json({ error: "Give the address of a page that lists companies." });

  if (req.body?.dry_run === true) {
    return res.json({
      ...plan,
      firecrawl_connected: connected.firecrawl,
      tinyfish_connected: connected.tinyfish,
      ready: plan.provider === "firecrawl" ? connected.firecrawl : connected.tinyfish,
    });
  }

  try {
    if (plan.provider === "firecrawl") {
      const apiKey = researchKey(db, ctx.workspaceId, "firecrawl");
      if (!apiKey) return res.status(400).json({ error: "Connect Firecrawl under Integrations to read a listing page." });
      const found = await sourceWithFirecrawl(plan.url, apiKey);
      const kept = keepSourced(db, ctx.workspaceId, found);
      if (found.length > 0) recordAudit(ctx, "companies.sourced", "company", undefined, { ...kept, found: found.length, url: plan.url, provider: "firecrawl" });
      return res.json({ done: true, provider: "firecrawl", found: found.length, ...kept });
    }

    const apiKey = researchKey(db, ctx.workspaceId, "tinyfish");
    if (!apiKey) return res.status(400).json({ error: "This page needs a search or a sign-in to list anything. Connect TinyFish under Integrations to let an agent work it." });
    const goal = typeof req.body?.goal === "string" && req.body.goal.trim()
      ? req.body.goal.trim()
      : "Find every company this page can list, working any search box or filters needed, and return each one's name and website.";
    const state = await sourceWithTinyfish(plan.url, goal, apiKey);
    if (!state.done) return res.json({ done: false, provider: "tinyfish", run_id: state.run_id, status: state.status });
    const kept = keepSourced(db, ctx.workspaceId, state.companies);
    if (state.companies.length > 0) recordAudit(ctx, "companies.sourced", "company", undefined, { ...kept, found: state.companies.length, url: plan.url, provider: "tinyfish", cost_usd: state.cost_usd });
    return res.json({ done: true, provider: "tinyfish", found: state.companies.length, ...kept, cost_usd: state.cost_usd });
  } catch (error) {
    if (error instanceof ResearchRefused) return res.status(502).json({ error: error.message });
    throw error;
  }
}
