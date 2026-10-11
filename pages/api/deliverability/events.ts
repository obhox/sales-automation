import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { GUARD_EVENT_KINDS, listGuardEvents, type GuardEventKind } from "@/lib/email/guard-events";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET ?domain=&kind=&limit=&offset= : the guard log, newest first, a page at a time.
 * `kind` is one of auto_pause, disconnected, reconnected, daily_limit, dns_change,
 * warmup_cycle, complaint, placement_test.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const kind = typeof req.query.kind === "string" && (GUARD_EVENT_KINDS as readonly string[]).includes(req.query.kind) ? (req.query.kind as GuardEventKind) : null;
  return res.json(listGuardEvents(getDb(), ctx.workspaceId, {
    domain: typeof req.query.domain === "string" && req.query.domain ? req.query.domain.toLowerCase() : null,
    kind, limit: Number(req.query.limit) || 25, offset: Number(req.query.offset) || 0,
  }));
}
