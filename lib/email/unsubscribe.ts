import { getDb } from "@/lib/db";
import { recordProviderEvent } from "@/lib/email/infrastructure";
import { stopAutomation } from "@/lib/community-replies";

/**
 * Act on a one-click unsubscribe for the email that job sent: stop writing to that address
 * from this workspace and take the contact out of every sequence. Safe to repeat, which
 * mail providers do. Returns false when the job never produced an email.
 */
export function recordUnsubscribe(jobId: string): boolean {
  const db = getDb();
  const sent = db.prepare("SELECT workspace_id, message_id, target_id FROM sent_messages WHERE job_id = ?")
    .get(jobId) as { workspace_id: string; message_id: string; target_id: string | null } | undefined;
  if (!sent) return false;

  // Suppresses the address, files the event against the sending mailbox and emits
  // email.unsubscribed. The event id makes a second request for the same email a no-op.
  recordProviderEvent({ workspaceId: sent.workspace_id, provider: "linki", providerEventId: `unsub:${jobId}`, eventType: "unsubscribed", messageId: sent.message_id });

  if (sent.target_id) {
    stopAutomation(sent.target_id, "Unsubscribed");
    db.prepare("UPDATE targets SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ? AND workspace_id = ?")
      .run(new Date().toISOString(), sent.target_id, sent.workspace_id);
  }
  return true;
}
