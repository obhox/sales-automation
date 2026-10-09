import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", id)) return;

  const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const { li_at, document_cookie } = req.body as { li_at?: string; document_cookie?: string };
  if (!li_at) return res.status(400).json({ error: "li_at cookie is required" });

  // Parse document.cookie string into cookie objects
  const extraCookies: { name: string; value: string; domain: string; path: string }[] = [];
  if (document_cookie) {
    for (const part of document_cookie.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const name = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (name && value) {
        extraCookies.push({ name, value, domain: ".linkedin.com", path: "/" });
      }
    }
  }

  // Build Playwright-compatible storageState
  const storageState = {
    cookies: [
      { name: "li_at", value: li_at.trim(), domain: ".linkedin.com", path: "/", httpOnly: true, secure: true, sameSite: "None" as const },
      ...extraCookies.filter((c) => c.name !== "li_at"),
    ],
    origins: [],
  };

  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
    encryptSecret(JSON.stringify(storageState)),
    id
  );

  // Evict the cached browser context so next import uses the new cookies
  const { closeSession } = await import("@/lib/linkedin/session");
  await closeSession(id);

  // Prove the cookie works before calling the account authenticated. A stale or mistyped
  // li_at used to be accepted here and only surface later, as a campaign failing contacts.
  // If the check itself cannot run (no browser on this host, a network error) the paste is
  // kept as given and reported as unverified — that is not evidence the cookie is bad.
  const { checkLinkedinSession } = await import("@/lib/linkedin/health");
  try {
    const { signedIn } = await checkLinkedinSession(id);
    if (!signedIn) {
      return res.status(400).json({ error: "LinkedIn did not accept this session cookie — it is expired or was copied incompletely. Copy a fresh li_at from a browser where you are signed in." });
    }
    return res.json({ ok: true, verified: true });
  } catch (err) {
    console.warn(`[authenticate] could not verify the session for ${id}:`, err instanceof Error ? err.message : err);
    return res.json({ ok: true, verified: false });
  }
}
