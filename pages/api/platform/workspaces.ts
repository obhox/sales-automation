import type { NextApiRequest, NextApiResponse } from "next";
import { createAdditionalWorkspace, getMemberships, recordAudit, requireWorkspace } from "@/lib/workspace";

// The workspaces a member belongs to, and making a new one.
//
// Switching is not done here: the current workspace lives in the session, so the client
// asks NextAuth to refresh it with the chosen id (which checks membership) and reloads.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "Workspaces belong to signed-in members" });

  if (req.method === "GET") {
    return res.json({ workspaces: getMemberships(ctx.userId), current: ctx.workspaceId });
  }

  if (req.method === "POST") {
    // Whoever creates a workspace owns it, so their role in the current one does not matter.
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    try {
      const created = createAdditionalWorkspace(ctx.userId, name);
      recordAudit({ workspaceId: created.workspaceId, userId: ctx.userId, role: "owner" }, "workspace.created", "workspace", created.workspaceId, { name: created.name });
      return res.status(201).json({ id: created.workspaceId, name: created.name });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Could not create the workspace" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
