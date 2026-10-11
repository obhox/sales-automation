import type { NextApiRequest, NextApiResponse } from "next";
import { requireWorkspace } from "@/lib/workspace";
import { getUserSettings, setUserSetting } from "@/lib/workspace-settings";

// Per-page product tour "seen" flags, kept per user (user_settings rows tour_seen_<page>):
// one person dismissing a tour says nothing about whether their colleagues have seen it.
const KEY_PREFIX = "tour_seen_";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res);
  if (!ctx) return;

  if (req.method === "GET") {
    // A call made on no user's behalf has no tours to have seen.
    const seen = ctx.userId ? Object.keys(getUserSettings(ctx.userId, KEY_PREFIX)) : [];
    return res.json({ seen });
  }

  if (req.method === "POST") {
    const { page } = req.body as { page?: string };
    if (!page) return res.status(400).json({ error: "page is required" });
    if (!ctx.userId) return res.status(400).json({ error: "Tour state belongs to a user" });
    setUserSetting(ctx.userId, `${KEY_PREFIX}${page}`, "1");
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
