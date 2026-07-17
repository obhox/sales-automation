import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { testSmtpConnection, testImapConnection } from "@/lib/email/sender";
import { decryptSecret } from "@/lib/crypto";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

interface AccountRow {
  from_email: string;
  from_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  imap_host: string | null;
  imap_port: number;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
  allow_self_signed: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "email_accounts", id)) return;

  const row = db
    .prepare("SELECT * FROM email_accounts WHERE id = ? AND workspace_id = ?")
    .get(id, ctx.workspaceId) as AccountRow | undefined;

  if (!row) return res.status(404).json({ error: "not found" });

  const account: AccountRow = {
    ...row,
    password: decryptSecret(row.password)!,
    imap_password: decryptSecret(row.imap_password),
  };

  const smtpError = await testSmtpConnection(account);

  let imapError: string | null = null;
  if (account.imap_host) {
    imapError = await testImapConnection({
      imap_host: account.imap_host,
      imap_port: account.imap_port ?? 993,
      username: account.username,
      password: account.password,
      imap_username: account.imap_username,
      imap_password: account.imap_password,
      allow_self_signed: account.allow_self_signed,
    });
  }

  const ok = !smtpError && !imapError;

  if (ok) {
    db.prepare("UPDATE email_accounts SET is_verified = 1 WHERE id = ?").run(id);
  }

  return res.status(ok ? 200 : 400).json({
    ok,
    smtp: smtpError ? { ok: false, error: smtpError } : { ok: true },
    imap: account.imap_host
      ? (imapError ? { ok: false, error: imapError } : { ok: true })
      : null,
  });
}
