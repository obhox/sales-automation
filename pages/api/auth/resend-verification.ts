import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { systemMailerConfigured } from "@/lib/email/system-mailer";
import { sendVerificationEmail } from "@/lib/account-mail";
import { normalizeInvitationEmail } from "@/lib/workspace-invitations";

/** POST { email } → mail a new confirmation link if that address has an unconfirmed account. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (isRateLimited(req, "resend-verification", 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  if (!systemMailerConfigured()) return res.status(503).json({ error: "Email confirmation is not set up on this server." });
  const email = typeof req.body?.email === "string" ? normalizeInvitationEmail(req.body.email) : "";
  if (!email) return res.status(400).json({ error: "Email is required." });

  const user = getDb().prepare("SELECT id, email FROM users WHERE lower(email) = ? AND email_verified_at IS NULL").get(email) as { id: string; email: string } | undefined;
  if (user) sendVerificationEmail(req, user);

  // The same answer either way: this must not say whether the address has an account.
  return res.status(200).json({ ok: true });
}
