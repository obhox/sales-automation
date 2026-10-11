import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { systemMailerConfigured } from "@/lib/email/system-mailer";
import { sendPasswordResetEmail } from "@/lib/account-mail";
import { normalizeInvitationEmail } from "@/lib/workspace-invitations";

/** POST { email } → mail a reset link if that address has an account. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (isRateLimited(req, "forgot-password", 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  if (!systemMailerConfigured()) {
    return res.status(503).json({ error: "Password reset by email is not set up on this server. Ask whoever runs it to reset your password." });
  }
  const email = typeof req.body?.email === "string" ? normalizeInvitationEmail(req.body.email) : "";
  if (!email) return res.status(400).json({ error: "Email is required." });

  const user = getDb().prepare("SELECT id, email FROM users WHERE lower(email) = ?").get(email) as { id: string; email: string } | undefined;
  if (user) sendPasswordResetEmail(req, user);

  // The same answer either way: this must not say whether the address has an account.
  return res.status(200).json({ ok: true });
}
