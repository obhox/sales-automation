import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { getTemplate, templateProblem, updateTemplate } from "@/lib/templates/library";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const template = getTemplate(db, ctx.workspaceId, id);
    if (!template) return res.status(404).json({ error: "Not found" });
    return res.json(template);
  }

  if (req.method === "PUT") {
    const problem = templateProblem(req.body ?? {}, false);
    if (problem) return res.status(400).json({ error: problem });
    const template = updateTemplate(db, ctx.workspaceId, id, req.body ?? {});
    if (!template) return res.status(404).json({ error: "Not found" });
    recordAudit(ctx, "template.updated", "template", id);
    return res.json(template);
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM templates WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "template.deleted", "template", id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
