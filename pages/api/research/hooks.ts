// Research a selection of contacts into a hook line each.
//
//   POST { dry_run: true, target_ids }   what researching these would cost
//   POST { target_ids }                  research at most HOOK_BATCH of them
//
// Each contact reads one page from their company's website (one Firecrawl credit) and asks
// a model for one sentence (billed to the workspace's AI budget). The screen asks the cost
// first, shows it, and sends the ids a batch at a time once someone has agreed. A dry run
// reaches no provider and spends nothing.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { AiBudgetReachedError } from "@/lib/ai/usage";
import { ResearchRefused, researchConnected } from "@/lib/research/providers";
import {
  HOOK_BATCH, HOOK_FIELD_KEY, HookUnavailable, MAX_HOOK_RUN,
  hookCandidates, hookContext, hookCost, writeHookLine, type HookOutcome,
} from "@/lib/research/hooks";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export { HOOK_BATCH };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();

  const asked = Array.isArray(req.body?.target_ids) ? [...new Set(req.body.target_ids.filter((id: unknown) => typeof id === "string"))] as string[] : null;
  if (!asked || asked.length === 0) return res.status(400).json({ error: "target_ids must be a non-empty array" });
  if (asked.length > MAX_HOOK_RUN) return res.status(400).json({ error: `Research at most ${MAX_HOOK_RUN} contacts at a time` });

  const candidates = hookCandidates(db, ctx.workspaceId, asked);
  const connected = researchConnected(db, ctx.workspaceId);

  if (req.body?.dry_run === true) {
    // Answered even when nothing is connected, so the screen can show the cost and the
    // "not connected" warning together rather than one and then the other.
    return res.json({
      ...hookCost(candidates, asked.length),
      firecrawl_connected: connected.firecrawl,
      tinyfish_connected: connected.tinyfish,
      field_key: HOOK_FIELD_KEY,
    });
  }

  if (asked.length > HOOK_BATCH) return res.status(400).json({ error: `Send at most ${HOOK_BATCH} contacts in one request` });

  let context: ReturnType<typeof hookContext>;
  try {
    context = hookContext(db, ctx.workspaceId);
  } catch (error) {
    if (error instanceof HookUnavailable) return res.status(400).json({ error: error.message });
    throw error;
  }

  const result: Record<HookOutcome, number> = { written: 0, no_website: 0, unreadable: 0, no_hook: 0 };
  let stopped: string | null = null;
  for (const candidate of candidates) {
    try {
      result[await writeHookLine(db, ctx.workspaceId, candidate, context)] += 1;
    } catch (error) {
      // A provider that refused, or an exhausted AI budget, will answer the same way for
      // every contact left. Stopping reports what was done instead of failing the rest one
      // by one and spending on each attempt.
      if (error instanceof ResearchRefused || error instanceof AiBudgetReachedError) {
        stopped = error.message;
        break;
      }
      result.unreadable += 1;
    }
  }

  const done = result.written + result.no_hook;
  if (done > 0) recordAudit(ctx, "contacts.researched", "contact", asked.length === 1 ? asked[0] : undefined, { ...result, credits: done });
  if (stopped) return res.status(502).json({ error: stopped, ...result });
  return res.json(result);
}
