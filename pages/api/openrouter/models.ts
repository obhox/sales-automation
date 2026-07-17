import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { requireWorkspace } from "@/lib/workspace";

interface OpenRouterModel {
  id?: string;
  name?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx=requireWorkspace(req,res); if(!ctx)return;

  const db = getDb();
  const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(ctx.workspaceId) as { api_key: string | null } | undefined;
  const apiKey = decryptSecret(row?.api_key ?? null);
  if (!apiKey) return res.status(400).json({ error: "OpenRouter API key is not configured", models: [] });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json() as { data?: OpenRouterModel[]; error?: { message?: string } };
    if (!response.ok) {
      return res.status(response.status).json({ error: payload.error?.message || "Failed to load OpenRouter models", models: [] });
    }

    const models = (payload.data ?? [])
      .filter((model): model is Required<OpenRouterModel> => !!model.id && !!model.name)
      .map((model) => ({ id: model.id, name: model.name, provider: model.id.split("/")[0] || "other" }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

    return res.json({ models });
  } catch (error) {
    console.error("[openrouter-models]", error);
    return res.status(502).json({ error: "Could not reach OpenRouter", models: [] });
  }
}
