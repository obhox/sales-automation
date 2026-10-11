// Add a file to the member's draft in a conversation. The file is the request body as it
// is; its name comes in the query string and its type in Content-Type.
//
//   POST /api/conversations/:id/attachments?filename=report.pdf   (body: the file)   201 { attachment }
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { conversationById } from "@/lib/conversations/rows";
import { addDraftAttachment, ATTACHMENT_MAX_BYTES } from "@/lib/conversations/store";
import { requireWorkspace } from "@/lib/workspace";

// The body is a file, not JSON: read as it arrives, and refused as soon as it is too big.
export const config = { api: { bodyParser: false } };

function readBody(req: NextApiRequest, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "A draft belongs to a member" });
  const db = getDb();
  const conversation = conversationById(db, ctx.workspaceId, String(req.query.id ?? ""));
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) return res.status(413).json({ error: `A file can be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB` });
  // A test hands the bytes over already read; a real request is a stream.
  const content = Buffer.isBuffer(req.body) ? req.body : await readBody(req, ATTACHMENT_MAX_BYTES);
  if (!content) return res.status(413).json({ error: `A file can be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB` });
  try {
    const attachment = addDraftAttachment(db, conversation, ctx.userId, {
      filename: typeof req.query.filename === "string" ? req.query.filename : "attachment",
      contentType: String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim(),
      content,
    });
    return res.status(201).json({ attachment });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "That file could not be added" });
  }
}
