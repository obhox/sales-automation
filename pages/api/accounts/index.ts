import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { listLinkedinAccounts, listedLinkedinAccount } from "@/lib/linkedin/account-list";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") return res.json(listLinkedinAccounts(db, ctx.workspaceId));

  if (req.method === "POST") {
    const { name, email, daily_connection_limit = 20, daily_message_limit = 50, daily_inmail_limit = 15, daily_visit_limit = 150 } = req.body;
    if (!name || !email) return res.status(400).json({ error: "name and email required" });
    try {
      const id = randomUUID();
      db
        .prepare(
          "INSERT INTO accounts (id, workspace_id, name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit, daily_visit_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, ctx.workspaceId, name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit, Math.min(150, daily_visit_limit));
      const account = listedLinkedinAccount(db, ctx.workspaceId, id);
      recordAudit(ctx, "account.created", "account", id);
      return res.status(201).json(account);
    } catch {
      return res.status(409).json({ error: "Email already exists" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
