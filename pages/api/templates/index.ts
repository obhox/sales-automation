import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { createTemplate, listTemplates, templateProblem } from "@/lib/templates/library";

/**
 *   GET   every template, newest first. ?channel=linkedin|email keeps one channel.
 *   POST  { name, body, channel?, subject?, category? }
 *
 * A template is a LinkedIn message unless it says it is an email; only an email has a subject.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const channel = Array.isArray(req.query.channel) ? req.query.channel[0] : req.query.channel;
    return res.json(listTemplates(db, ctx.workspaceId, { channel }));
  }

  if (req.method === "POST") {
    const problem = templateProblem(req.body ?? {}, true);
    if (problem) return res.status(400).json({ error: problem });
    const template = createTemplate(db, ctx.workspaceId, req.body);
    recordAudit(ctx, "template.created", "template", template.id);
    return res.status(201).json(template);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
