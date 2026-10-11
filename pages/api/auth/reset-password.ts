import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { consumeAuthToken, revokeUserSessions } from "@/lib/auth-tokens";
import { signupSchema, firstIssue } from "@/lib/validation";

/** POST { token, password } → set a new password with the link from the reset email. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (isRateLimited(req, "reset-password", 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  // Check the password before spending the link, so a rejected password can be corrected.
  const password = signupSchema.shape.password.safeParse(req.body?.password);
  if (!password.success) return res.status(400).json({ error: firstIssue(password.error, "Password is required.") });

  const spent = consumeAuthToken(token, "password_reset");
  if (!spent) return res.status(400).json({ error: "This reset link has expired or was already used. Ask for a new one." });

  const hash = await bcrypt.hash(password.data, 10);
  // Opening the link proves the address is read, so it also confirms the email.
  getDb().prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(hash, spent.userId);
  revokeUserSessions(spent.userId);
  return res.status(200).json({ ok: true });
}
