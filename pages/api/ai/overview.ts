import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { readAiConfig, type AiConfigView } from "@/lib/ai/config";
import { aiCampaigns, type AiCampaign } from "@/lib/ai/steps";
import { usageOverview, type UsageOverview } from "@/lib/ai/usage";
import { capabilities } from "@/lib/premium";
import { requireWorkspace } from "@/lib/workspace";

// Everything the AI & models screen shows on arrival, in one request: whether a provider
// key is in place, the settings, this month's spend against the budget, and the campaigns
// whose steps can be written by AI.

export interface AiOverview {
  /** False when this build has no AI writer: the screen says so and offers nothing else. */
  available: boolean;
  provider: {
    connected: boolean;
    /** The key with all but its last four characters hidden. Never the key itself. */
    key_hint: string | null;
    key_updated_at: string | null;
  };
  config: AiConfigView;
  usage: UsageOverview;
  campaigns: AiCampaign[];
}

/** "sk-or-v1-••••••••7d2c": the prefix that says what kind of key it is, and the last four characters. */
export function keyHint(key: string): string {
  const prefix = /^sk-or-v\d+-/.exec(key)?.[0] ?? "";
  return `${prefix}••••••••${key.slice(-4)}`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const db = getDb();

  const integration = db.prepare("SELECT api_key, updated_at FROM integrations WHERE workspace_id = ? AND key = 'openrouter'").get(ctx.workspaceId) as { api_key: string | null; updated_at: string | null } | undefined;
  const key = decryptSecret(integration?.api_key ?? null);

  const payload: AiOverview = {
    available: Boolean(capabilities.ai),
    provider: { connected: Boolean(key), key_hint: key ? keyHint(key) : null, key_updated_at: key ? integration?.updated_at ?? null : null },
    config: readAiConfig(ctx.workspaceId),
    usage: usageOverview(ctx.workspaceId),
    campaigns: aiCampaigns(db, ctx.workspaceId),
  };
  return res.json(payload);
}
