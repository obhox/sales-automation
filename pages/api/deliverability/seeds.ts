import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { addSeed, listSeeds, removeSeed } from "@/lib/email/placement";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * The addresses a placement test is sent to.
 *   GET                       the seeds, each saying whether Linki can read its mailbox
 *   POST { email, label? }    add one (admin)
 *   DELETE ?id=               remove one (admin)
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin"); if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") return res.json({ seeds: listSeeds(db, ctx.workspaceId) });

  if (req.method === "POST") {
    const seed = addSeed(db, ctx.workspaceId, (req.body ?? {}) as { email?: unknown; label?: unknown }, ctx.userId);
    if (typeof seed === "string") return res.status(400).json({ error: seed });
    recordAudit(ctx, "placement_seed.added", "placement_seed", seed.id, { email: seed.email });
    return res.status(201).json(seed);
  }

  if (req.method === "DELETE") {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!removeSeed(db, ctx.workspaceId, id)) return res.status(404).json({ error: "not found" });
    recordAudit(ctx, "placement_seed.removed", "placement_seed", id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "POST", "DELETE"]);
  return res.status(405).end();
}
