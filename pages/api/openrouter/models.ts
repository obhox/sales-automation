import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { modelsFromListing, openrouterUrl } from "@/lib/ai/openrouter";
import { requireWorkspace } from "@/lib/workspace";

/** Every model the workspace's OpenRouter key can use, with its price per million tokens. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx=requireWorkspace(req,res); if(!ctx)return;

  const db = getDb();
  const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(ctx.workspaceId) as { api_key: string | null } | undefined;
  const apiKey = decryptSecret(row?.api_key ?? null);
  if (!apiKey) return res.status(400).json({ error: "OpenRouter API key is not configured", models: [] });

  try {
    const response = await fetch(openrouterUrl("/models"), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json() as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      return res.status(response.status).json({ error: payload.error?.message || "Failed to load OpenRouter models", models: [] });
    }
    return res.json({ models: modelsFromListing(payload) });
  } catch (error) {
    console.error("[openrouter-models]", error);
    return res.status(502).json({ error: "Could not reach OpenRouter", models: [] });
  }
}
