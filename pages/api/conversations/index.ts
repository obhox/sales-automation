// The inbox's conversations, one per contact who has written back.
//
//   GET /api/conversations?view=&verdict=&status=&temperature=&assignee=&sla=&tag=&channel=&campaign=&q=&sort=&page=&per=   (`limit` is read as `per`)
//
// Filters that take several values take them comma-separated. `view` is all, unread or
// mine; `assignee` takes member ids, "me" and "none"; `sla` is overdue or today. The
// answer carries the page, the total, and the counts beside each filter.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { conversationFacets, listConversations, parseFilters, type ConversationFacets, type ConversationItem } from "@/lib/conversations/list";
import { settleConversations } from "@/lib/conversations/store";
import { requireWorkspace } from "@/lib/workspace";

export interface ConversationsResponse { conversations: ConversationItem[]; total: number; page: number; per: number; facets: ConversationFacets }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const db = getDb();
  // Snoozes that have run out are opened, and anything stored without a conversation gets one.
  settleConversations(db, ctx.workspaceId, { force: true });

  const filters = parseFilters(req.query);
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  // `limit` is what a list screen's table state calls it.
  const per = Math.min(100, Math.max(1, Math.floor(Number(req.query.per ?? req.query.limit)) || 25));
  const { conversations, total } = listConversations(db, ctx, filters, { limit: per, offset: (page - 1) * per });
  const body: ConversationsResponse = { conversations, total, page, per, facets: conversationFacets(db, ctx, filters) };
  return res.json(body);
}
