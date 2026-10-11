import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { modelsFromListing, openrouterUrl, type ModelInfo } from "@/lib/ai/openrouter";
import { geminiModels } from "@/lib/ai/gemini";
import { rateFor } from "@/lib/ai/gemini-prices";
import { aiKey } from "@/lib/ai/providers";
import { requireWorkspace } from "@/lib/workspace";

/**
 * Every model this workspace can choose, from each AI provider it has connected.
 *
 * Both providers are asked, and either one failing does not hide the other: a workspace
 * with a Gemini key and an expired OpenRouter one should still be able to pick a model.
 * What could not be reached comes back in `unavailable` so the screen can say so rather
 * than quietly offering a shorter list.
 *
 * Gemini models arrive already prefixed `gemini/`, which is how this app routes a request
 * to Google directly rather than through OpenRouter — and because the picker groups by the
 * part before the slash, they group themselves under their own heading.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx = requireWorkspace(req, res);
  if (!ctx) return;

  const db = getDb();
  const openrouter = aiKey(db, ctx.workspaceId, "openrouter");
  const gemini = aiKey(db, ctx.workspaceId, "gemini");
  if (!openrouter && !gemini) {
    return res.status(400).json({ error: "No AI provider is connected. Add an OpenRouter or Google Gemini API key.", models: [] });
  }

  const models: ModelInfo[] = [];
  const unavailable: string[] = [];

  if (openrouter) {
    try {
      const response = await fetch(openrouterUrl("/models"), { headers: { Authorization: `Bearer ${openrouter}` } });
      const payload = await response.json() as { data?: unknown; error?: { message?: string } };
      if (response.ok) models.push(...modelsFromListing(payload));
      else unavailable.push(payload.error?.message || `OpenRouter answered ${response.status}`);
    } catch (error) {
      console.error("[models] openrouter", error);
      unavailable.push("OpenRouter could not be reached");
    }
  }

  if (gemini) {
    try {
      // Gemini's own listing carries no prices, so they come from the table this app
      // bills against. A model missing from that table shows no price, which is the
      // honest signal: its spend will not be counted against the AI budget either.
      models.push(...(await geminiModels(gemini)).map((model): ModelInfo => {
        const rate = rateFor(model.id.replace(/^gemini\//, ""));
        return {
          id: model.id, name: model.name, provider: "gemini",
          input_price: rate?.input ?? null, output_price: rate?.output ?? null,
          context_length: model.context,
        };
      }));
    } catch (error) {
      console.error("[models] gemini", error);
      unavailable.push(error instanceof Error ? error.message : "Gemini could not be reached");
    }
  }

  if (models.length === 0 && unavailable.length > 0) {
    return res.status(502).json({ error: unavailable.join("; "), models: [] });
  }
  return res.json({ models, unavailable });
}
