import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requestOrigin } from "@/lib/mcp/auth";
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { CalendarOAuthError, completeCalendarOAuth, isCalendarOAuthProvider, readCalendarState } from "@/lib/platform/calendar-oauth";
import { syncConnection } from "@/lib/platform/connectors";
import { calendarReturn } from "./start";

/**
 * Where Google or Microsoft sends the member back after they sign in to their calendar.
 * Keeps the connection, starts reading the calendar, and returns them to the calendars
 * panel. Every way this can fail ends at that panel with a reason; none of them shows the
 * member a token or the provider's raw answer.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;
  const provider = req.query.provider;
  if (!isCalendarOAuthProvider(provider)) return res.status(404).json({ error: "Unknown calendar provider" });
  const back = (outcome: Record<string, string>) => res.redirect(302, calendarReturn({ ...outcome, provider }));

  // The member said no at the provider, or the provider refused.
  if (typeof req.query.error === "string") return back({ calendar_error: req.query.error === "access_denied" ? "declined" : "provider" });
  const state = typeof req.query.state === "string" ? readCalendarState(req.query.state) : null;
  const code = typeof req.query.code === "string" ? req.query.code : "";
  // The state has to be ours, in date, and made for this member in this workspace.
  if (!state || !code || state.provider !== provider || state.userId !== ctx.userId || state.workspaceId !== ctx.workspaceId) return back({ calendar_error: "expired" });

  try {
    const connection = await completeCalendarOAuth(getDb(), { ...state, code, origin: requestOrigin(req) });
    recordAudit(ctx, connection.created ? "connection.created" : "connection.updated", "external_connection", connection.id, { provider, method: "oauth" });
    // Read the calendar now, without keeping the member waiting for it. A failure is kept on the connection and shown in the panel.
    void syncConnection(connection.id, ctx.workspaceId).catch(() => {});
    return back({ calendar: "connected" });
  } catch (error) {
    if (!(error instanceof CalendarOAuthError)) console.warn("[calendar-oauth] sign-in could not be finished:", error instanceof Error ? error.message : error);
    return back({ calendar_error: "exchange" });
  }
}
