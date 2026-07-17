import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { isRateLimited } from "@/lib/rate-limit";
import { createWorkspaceForUser } from "@/lib/workspace";
import { acceptWorkspaceInvitation, getInvitationByToken, normalizeInvitationEmail } from "@/lib/workspace-invitations";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  // Open registration still needs basic abuse protection.
  if (isRateLimited(req, "signup", 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const { email, password, invite_token } = req.body as {
    email?: string;
    password?: string;
    invite_token?: string;
  };

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const db = getDb();
  const normalizedEmail = normalizeInvitationEmail(email);
  const invitation = invite_token ? getInvitationByToken(invite_token) : null;
  if (invite_token && (!invitation || invitation.status !== "pending" || invitation.email !== normalizedEmail)) {
    return res.status(400).json({ error: "This invitation is invalid, expired, or belongs to another email address." });
  }
  const existing = db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const hash = await bcrypt.hash(password, 10);
  const userId = randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(userId, normalizedEmail, hash);
  try {
    if (invite_token) acceptWorkspaceInvitation(invite_token, userId, normalizedEmail);
    else createWorkspaceForUser(userId, normalizedEmail);
  } catch (error) {
    db.prepare("DELETE FROM users WHERE id=?").run(userId);
    return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to accept invitation" });
  }

  return res.status(201).json({ ok: true, workspace_id: invitation?.workspace_id });
}
