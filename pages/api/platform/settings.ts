import type { NextApiRequest, NextApiResponse } from "next";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { getWorkspaceSwitches, isWorkspaceSwitch, setWorkspaceSwitch } from "@/lib/workspace-settings";

/** GET → { settings }, PUT { <switch>: boolean, ... } → change this workspace's switches. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") {
    return res.json({ settings: getWorkspaceSwitches(ctx.workspaceId) });
  }

  if (req.method === "PUT") {
    const changes = Object.entries((req.body ?? {}) as Record<string, unknown>);
    if (changes.length === 0) return res.status(400).json({ error: "No settings given" });
    for (const [key, value] of changes) {
      if (!isWorkspaceSwitch(key)) return res.status(400).json({ error: `Unknown setting: ${key}` });
      if (typeof value !== "boolean") return res.status(400).json({ error: `${key} must be true or false` });
    }
    for (const [key, value] of changes) {
      if (isWorkspaceSwitch(key)) setWorkspaceSwitch(ctx.workspaceId, key, value as boolean);
    }
    recordAudit(ctx, "workspace.settings_updated", "workspace", ctx.workspaceId, Object.fromEntries(changes));
    return res.json({ settings: getWorkspaceSwitches(ctx.workspaceId) });
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
