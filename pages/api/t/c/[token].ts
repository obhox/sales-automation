import type { NextApiRequest, NextApiResponse } from "next";
import { createHash } from "crypto";
import { getDb } from "@/lib/db";
import { recordProviderEvent } from "@/lib/email/infrastructure";
import { decodeTrackingDestination, verifyTrackingToken } from "@/lib/email/content";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const destination = decodeTrackingDestination(String(req.query.u ?? ""));
  if (!destination) return res.status(400).json({ error: "Invalid destination" });

  const token = String(req.query.token ?? "");
  const jobId = verifyTrackingToken("click", token, destination);
  if (!jobId) return res.status(400).json({ error: "Invalid tracking token" });

  const sent = getDb().prepare("SELECT workspace_id, message_id FROM sent_messages WHERE job_id = ?").get(jobId) as { workspace_id: string; message_id: string } | undefined;
  if (sent) {
    const destinationId = createHash("sha256").update(destination).digest("hex").slice(0, 20);
    recordProviderEvent({
      workspaceId: sent.workspace_id,
      provider: "linki",
      providerEventId: `click:${jobId}:${destinationId}`,
      eventType: "clicked",
      messageId: sent.message_id,
      occurredAt: new Date().toISOString(),
      payload: { destination },
    });
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", destination);
  return res.status(302).end();
}
