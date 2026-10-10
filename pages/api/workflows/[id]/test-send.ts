import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { previewContact, previewSenders, previewStep } from "@/lib/outreach/preview";
import type { StepInput } from "@/lib/outreach/publish";
import { isAddressSuppressed } from "@/lib/platform/suppression";
import { roleAtLeast } from "@/lib/roles";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * Send one email step to yourself, written out for a contact of your choosing.
 *   POST { step, target_id, email_account_id, pick?, to? }
 *   → { ok, to, subject, job_id }
 *
 * It goes to the address you are signed in with. An admin may name another address in
 * `to`. The subject is marked "[Test]", nothing is tracked, and the place where the
 * unsubscribe link would be says so in words: a test must not be able to opt a real
 * contact out. Only an email step can be tested this way; a LinkedIn step has nowhere
 * safe to go.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const { step, target_id, email_account_id, pick, to } = (req.body ?? {}) as { step?: StepInput; target_id?: string; email_account_id?: string; pick?: number; to?: string };

  if (!step || typeof step !== "object" || step.step_type !== "email") return res.status(400).json({ error: "Only an email step can be sent as a test" });
  if (step.ai_enabled) return res.status(400).json({ error: "This step is written by AI for each contact when it is sent, so there is no fixed text to test. Use the AI preview instead." });
  if (typeof target_id !== "string" || !target_id) return res.status(400).json({ error: "Choose a contact to write the test for" });
  if (typeof email_account_id !== "string" || !email_account_id) return res.status(400).json({ error: "Choose a mailbox to send the test from" });
  if (!requireWorkspaceEntity(res, ctx, "email_accounts", email_account_id)) return;
  const contact = previewContact(db, ctx.workspaceId, target_id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  const own = ctx.userId ? (db.prepare("SELECT email FROM users WHERE id = ?").get(ctx.userId) as { email: string } | undefined)?.email : undefined;
  const other = typeof to === "string" && to.trim() && to.trim().toLowerCase() !== own?.toLowerCase() ? to.trim() : null;
  if (other && !roleAtLeast(ctx.role, "admin")) return res.status(403).json({ error: "A test goes to your own address. An admin can send one elsewhere.", required_role: "admin" });
  const recipient = other ?? own;
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return res.status(400).json({ error: "There is no address to send the test to" });
  const suppression = isAddressSuppressed(ctx.workspaceId, recipient);
  if (suppression) return res.status(409).json({ error: "That address is on the do-not-contact list", suppression });

  const senders = previewSenders(db, ctx.workspaceId, workflowId, { emailAccountId: email_account_id });
  const preview = previewStep(db, ctx.workspaceId, contact, step, senders, { pick: Number.isInteger(pick) ? pick : 0 });
  if (preview.content !== "text" || !preview.body) return res.status(400).json({ error: preview.warnings[0] ?? "This step has nothing to send yet." });

  const subject = `[Test] ${preview.subject || "(no subject)"}`;
  const body = preview.signature ? `${preview.body}\n\n--\n${preview.signature}` : preview.body;
  try {
    const receipt = await sendEmailDurably({
      workspaceId: ctx.workspaceId, emailAccountId: email_account_id, idempotencyKey: `test:${randomUUID()}`, source: "test",
      to: recipient, subject, body, deliveryMode: step.email_delivery_mode === "enhanced" ? "enhanced" : "plain", trackOpens: false, trackClicks: false,
    });
    return res.json({ ok: true, to: recipient, subject, job_id: receipt.jobId, warnings: preview.warnings });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "The test could not be sent" });
  }
}
