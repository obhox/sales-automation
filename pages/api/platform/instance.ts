import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { readInstanceHealth } from "@/lib/system/instance";
import { requireWorkspace } from "@/lib/workspace";

// Which background loop is behind, the database's size and the uptime: for admins. Everyone
// else sees only the one-line health in the sidebar (pages/api/shell.ts).
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;
  return res.json(readInstanceHealth(getDb(), ctx.workspaceId));
}
