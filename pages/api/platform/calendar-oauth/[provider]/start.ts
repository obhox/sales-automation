import type { NextApiRequest, NextApiResponse } from "next";
import { requestOrigin } from "@/lib/mcp/auth";
import { requireWorkspace } from "@/lib/workspace";
import { calendarAuthorizationUrl, calendarOAuthAvailability, isCalendarOAuthProvider } from "@/lib/platform/calendar-oauth";

/** Where a browser is sent back to, with what happened in the address so the screen can say it. */
export const calendarReturn = (outcome: Record<string, string>) => `/pipeline?${new URLSearchParams({ view: "meetings", calendars: "1", ...outcome })}`;

/**
 * Send the member to Google or Microsoft to sign in to their calendar. Opened as a link,
 * so anything that stops it sends them back to the calendars panel with the reason rather
 * than leaving them on a page of JSON.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  // Connections are an admin's to make, here as in /api/platform/connections.
  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;
  const provider = req.query.provider;
  if (!isCalendarOAuthProvider(provider)) return res.status(404).json({ error: "Unknown calendar provider" });
  if (!ctx.userId) return res.status(403).json({ error: "Connecting a calendar needs a signed-in member" });
  if (!calendarOAuthAvailability()[provider]) return res.redirect(302, calendarReturn({ calendar_error: "not_set_up", provider }));
  return res.redirect(302, calendarAuthorizationUrl({ provider, workspaceId: ctx.workspaceId, userId: ctx.userId, origin: requestOrigin(req) }));
}
