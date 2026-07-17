import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { isAddressSuppressed } from "@/lib/platform/suppression";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "email_accounts", id)) return;
  const { to, subject, body, delivery_mode, track_opens, track_clicks } = req.body as { to?: string; subject?: string; body?: string; delivery_mode?: "plain" | "enhanced"; track_opens?: boolean; track_clicks?: boolean };

  if (!to) return res.status(400).json({ error: "to is required" });

  const account = db
    .prepare("SELECT * FROM email_accounts WHERE id = ? AND workspace_id = ?")
    .get(id, ctx.workspaceId) as {
      id: string; from_email: string; from_name: string | null;
      smtp_host: string; smtp_port: number; smtp_secure: number;
      username: string; password: string; signature: string | null;
    } | undefined;

  if (!account) return res.status(404).json({ error: "not found" });
  const suppression = isAddressSuppressed(ctx.workspaceId, to);
  if (suppression) return res.status(409).json({ error: "Recipient is suppressed", suppression });

  const fullBody = buildEmailBody(body ?? "", account.signature);

  try {
    const receipt=await sendEmailDurably({workspaceId:ctx.workspaceId,emailAccountId:id,idempotencyKey:`test:${randomUUID()}`,source:"test",to,subject:subject??"Test email from Linki",body:fullBody,deliveryMode:delivery_mode==="enhanced"?"enhanced":"plain",trackOpens:delivery_mode==="enhanced"&&Boolean(track_opens),trackClicks:delivery_mode==="enhanced"&&Boolean(track_clicks)});
    return res.json({ ok: true, job_id:receipt.jobId, message_id:receipt.messageId });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

function buildEmailBody(body: string, signature: string | null): string {
  const sig = signature?.trim();
  if (!sig) return body;
  return `${body}\n\n--\n${sig}`;
}
