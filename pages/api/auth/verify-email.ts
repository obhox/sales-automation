import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { consumeAuthToken } from "@/lib/auth-tokens";

/** POST { token } → confirm the address with the link from the signup email. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (isRateLimited(req, "verify-email", 20, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const spent = consumeAuthToken(typeof req.body?.token === "string" ? req.body.token : "", "email_verify");
  if (!spent) return res.status(400).json({ error: "This confirmation link has expired or was already used." });
  getDb().prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(spent.userId);
  return res.status(200).json({ ok: true });
}
