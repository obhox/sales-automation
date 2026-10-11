import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { isPriority, listTasks, taskCounts, type TaskFilters } from "@/lib/pipeline/tasks";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The pipeline screen's task list: each task with the names of what it is about and who
 * has it, a page at a time, and the counts shown beside the list. Tasks are written
 * through /api/todos.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const db = getDb();
  const status = req.query.status === "done" || req.query.status === "all" ? req.query.status : "open";
  const priority = text(req.query.priority);
  const filters: TaskFilters = {
    status, assignee: text(req.query.assignee), overdue: req.query.overdue === "1" || req.query.overdue === "true",
    priority: isPriority(priority) ? priority : null, q: text(req.query.q), target_id: text(req.query.target_id), opportunity_id: text(req.query.opportunity_id),
  };
  if (filters.assignee === "all") filters.assignee = null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const who = { workspaceId: ctx.workspaceId, userId: ctx.userId };
  const now = new Date();
  return res.json({ ...listTasks(db, who, filters, { limit, offset: (page - 1) * limit }, now), counts: taskCounts(db, who, now, text(req.query.day_start)), page, limit });
}
