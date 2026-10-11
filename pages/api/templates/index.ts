import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { createTemplate, listTemplates, templateCategories, templateProblem, type Template } from "@/lib/templates/library";
import { templateFigures, type TemplateFigures } from "@/lib/templates/usage";

/** A template with how it has done. `figures` is null for one never sent and offered by no step. */
export interface LibraryTemplate extends Template {
  figures: TemplateFigures | null;
}

export interface TemplateLibrary {
  templates: LibraryTemplate[];
  /** The categories in use, in name order. */
  categories: string[];
}

/**
 *   GET   every template, newest first. ?channel=linkedin|email keeps one channel.
 *         ?view=library adds each template's figures and the categories in use, for the Templates screen.
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
    const templates = listTemplates(db, ctx.workspaceId, { channel });
    if (req.query.view !== "library") return res.json(templates);
    const figures = templateFigures(db, ctx.workspaceId);
    const library: TemplateLibrary = {
      templates: templates.map((template) => ({ ...template, figures: figures.get(template.id) ?? null })),
      categories: [...new Set(templateCategories(db, ctx.workspaceId).map((row) => row.category))],
    };
    return res.json(library);
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
