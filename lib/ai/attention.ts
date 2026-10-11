// What about a workspace's AI setup needs someone to act. One list, read by the AI &
// models screen and meant for the dashboard's "needs attention" and a campaign's
// pre-launch checks, so all three say the same thing.
import { getDb } from "@/lib/db";
import { anyAiConnected } from "@/lib/ai/providers";
import { budgetState } from "@/lib/ai/usage";

export interface AiNotice {
  code: "budget_reached" | "budget_nearly" | "no_key" | "no_model";
  tone: "bad" | "warn";
  title: string;
  detail: string;
  /** Where to go to deal with it. */
  link: "/ai";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dollars = (amount: number) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayInWords = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const steps = (count: number) => `${count} ${count === 1 ? "step is" : "steps are"}`;

/** Most pressing first. Empty when nothing needs anyone. */
export function aiAttention(workspaceId: string, now: Date = new Date()): AiNotice[] {
  const db = getDb();
  const notices: AiNotice[] = [];

  // Steps set to be written by AI in campaigns that are not archived.
  const written = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN COALESCE(s.ai_model, '') = '' THEN 1 ELSE 0 END), 0) AS on_default
     FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
     WHERE w.workspace_id = ? AND COALESCE(w.is_archived, 0) = 0 AND s.ai_enabled = 1 AND s.step_type IN ('email', 'message', 'sales_inmail')`,
  ).get(workspaceId) as { total: number; on_default: number };
  // Either provider can write, so this asks whether any is connected rather than naming
  // one. A workspace running Gemini used to be warned it had no OpenRouter key, which was
  // true and entirely beside the point.
  const key = anyAiConnected(db, workspaceId);
  const config = db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined;

  // The runner moves a contact past a step it cannot write, so these lose sends quietly.
  if (written.total > 0 && !key) {
    notices.push({
      code: "no_key", tone: "bad", link: "/ai",
      title: `${steps(written.total)} set to be written by AI, and no AI provider is connected`,
      detail: "Contacts who reach one of these steps are moved past it with nothing sent · add a key, or give the steps fixed wording",
    });
  } else if (written.on_default > 0 && !config?.default_model) {
    notices.push({
      code: "no_model", tone: "bad", link: "/ai",
      title: `${steps(written.on_default)} written by AI with no model chosen`,
      detail: "These steps name no model of their own and the workspace has no default · contacts who reach one are moved past it with nothing sent",
    });
  }

  const budget = budgetState(workspaceId, now);
  if (budget.budget_usd !== null && budget.reached) {
    notices.push({
      code: "budget_reached", tone: "bad", link: "/ai",
      title: `AI writing is paused: this month's budget of ${dollars(budget.budget_usd)} is used up`,
      detail: `Steps written by AI wait where they are and go out once the budget is raised or on ${dayInWords(budget.resets_on)} · steps with fixed wording, and the sorting of replies, carry on`,
    });
  } else if (budget.budget_usd !== null && budget.spent_usd >= budget.budget_usd * 0.8) {
    notices.push({
      code: "budget_nearly", tone: "warn", link: "/ai",
      title: `${Math.floor((budget.spent_usd / budget.budget_usd) * 100)}% of this month's AI budget is spent`,
      detail: `${dollars(budget.spent_usd)} of ${dollars(budget.budget_usd)} · steps written by AI wait once it is reached, until it is raised or ${dayInWords(budget.resets_on)}`,
    });
  }
  return notices;
}
