import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { checkImport } from "@/lib/csv-import-store";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET : what running this import would do, without doing it. How many rows become a contact,
 * change one, are duplicates (and by which detail), or are left out; what is wrong with the
 * rest, with the first rows of each kind; and `problem`, the reason it cannot run yet, if any.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const check = checkImport(getDb(), ctx.workspaceId, String(req.query.id ?? ""));
  if (!check) return res.status(404).json({ error: "Import not found" });
  if ("error" in check) return res.status(409).json({ error: check.error });
  return res.json(check);
}

export const config = { api: { responseLimit: false } };
