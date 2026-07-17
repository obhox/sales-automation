import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recordProviderEvent } from "@/lib/email/infrastructure";
import { verifyTrackingToken } from "@/lib/email/content";

const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const token = String(req.query.token ?? "");
  const jobId = verifyTrackingToken("open", token);

  if (jobId) {
    const sent = getDb().prepare("SELECT workspace_id, message_id FROM sent_messages WHERE job_id = ?").get(jobId) as { workspace_id: string; message_id: string } | undefined;
    if (sent) {
      recordProviderEvent({
        workspaceId: sent.workspace_id,
        provider: "linki",
        providerEventId: `open:${jobId}`,
        eventType: "opened",
        messageId: sent.message_id,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Content-Length", TRANSPARENT_GIF.length);
  return res.status(200).send(TRANSPARENT_GIF);
}
