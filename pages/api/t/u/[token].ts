import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { verifyTrackingToken } from "@/lib/email/content";
import { recordUnsubscribe } from "@/lib/email/unsubscribe";

// The address in a campaign email's List-Unsubscribe header (RFC 8058).
//
// POST is the unsubscribe. A mail client's own "unsubscribe" control sends one with no
// person involved, so it asks for nothing and is safe to repeat. There is deliberately no
// per-IP limit: a provider relays every recipient's request from the same few addresses,
// and a limit would silently drop real opt-outs. The token is signed, so it cannot be
// guessed for an email that was never sent.
//
// GET changes nothing. It is what a mail client without one-click support opens in a
// browser, and what link scanners fetch; it shows a page with a button that POSTs.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  const jobId = verifyTrackingToken("unsub", String(req.query.token ?? ""));
  const email = jobId
    ? getDb().prepare(`SELECT j.recipient, COALESCE(NULLIF(a.from_name, ''), a.from_email) AS sender
        FROM email_jobs j LEFT JOIN email_accounts a ON a.id = j.email_account_id WHERE j.id = ?`).get(jobId) as { recipient: string; sender: string | null } | undefined
    : undefined;
  if (!jobId || !email) {
    return res.status(404).send(page("This link is not valid", "<p>It may have been copied incompletely. Reply to the email and ask to be removed instead.</p>"));
  }
  const who = `<strong>${escapeHtml(email.recipient)}</strong>`;
  const from = email.sender ? ` from ${escapeHtml(email.sender)}` : "";

  if (req.method === "POST") {
    if (!recordUnsubscribe(jobId)) {
      return res.status(404).send(page("This link is not valid", "<p>Reply to the email and ask to be removed instead.</p>"));
    }
    return res.status(200).send(page("You are unsubscribed", `<p>${who} will get no more emails${from}.</p>`));
  }

  return res.status(200).send(page("Unsubscribe", `<p>Stop emails${from} to ${who}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:#f5f4ef;color:#1a2029;font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:26rem;margin:18vh auto 0;padding:2rem;background:#fff;border:1px solid #e3e1da;border-radius:14px}h1{margin:0 0 .75rem;font-size:1.5rem;font-weight:600;letter-spacing:-.01em}p{margin:0 0 1.25rem;color:#4b5563}strong{color:#1a2029;font-weight:500}button{font:inherit;font-weight:500;color:#fff;background:#1a2029;border:0;border-radius:10px;padding:.65rem 1.1rem;cursor:pointer}p:last-child{margin-bottom:0}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}
