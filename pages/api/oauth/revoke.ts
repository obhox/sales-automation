import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { hashToken } from "@/lib/mcp/auth";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token) getDb().prepare("DELETE FROM oauth_tokens WHERE access_hash = ? OR refresh_hash = ?").run(hashToken(token), hashToken(token));
  return res.status(200).end();
}

