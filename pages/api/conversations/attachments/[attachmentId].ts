// One file from a conversation: download it, or take it off a draft.
//
//   GET    /api/conversations/attachments/:attachmentId   the file, as a download
//   DELETE /api/conversations/attachments/:attachmentId   remove it from the member's own draft
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { readAttachment, removeDraftAttachment } from "@/lib/conversations/store";
import { requireWorkspace } from "@/lib/workspace";

export const config = { api: { responseLimit: false } };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "DELETE") {
    res.setHeader("Allow", ["GET", "DELETE"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  const id = String(req.query.attachmentId ?? "");

  if (req.method === "DELETE") {
    if (!ctx.userId || !removeDraftAttachment(db, ctx.workspaceId, id, ctx.userId)) return res.status(404).json({ error: "File not found on your draft" });
    return res.status(204).end();
  }
  const file = readAttachment(db, ctx.workspaceId, id);
  if (!file) return res.status(404).json({ error: "File not found" });
  // Always a download, never shown in the page: a file from outside is not to be trusted
  // to run here, whatever type it says it is.
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(file.content.length));
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(file.content);
}
