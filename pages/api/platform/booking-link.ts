import type { NextApiRequest, NextApiResponse } from "next";
import { bookingUrlProblem, getBookingUrl, setBookingUrl } from "@/lib/platform/booking";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

/**
 * The workspace's booking link.
 *
 *   GET            { url }            anyone in the workspace
 *   PUT { url }    { url }            an admin sets it; an empty value clears it
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") return res.json({ url: getBookingUrl(ctx.workspaceId) });

  if (req.method === "PUT") {
    const checked = bookingUrlProblem((req.body as { url?: unknown } | undefined)?.url);
    if (typeof checked === "string") return res.status(400).json({ error: checked });
    setBookingUrl(ctx.workspaceId, checked.url);
    recordAudit(ctx, "workspace.booking_link_updated", "workspace", ctx.workspaceId, { set: checked.url !== null });
    return res.json({ url: checked.url });
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
