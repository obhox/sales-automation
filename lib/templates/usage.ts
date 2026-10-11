// How each template has done, across every campaign that sent it: how often it went out,
// to how many people, and what came back. The crediting of replies is the reporting
// breakdown's own (lib/reporting/breakdown.ts), run for each campaign that used a template
// and added up, so a template's figures here agree with each campaign's "by template" table.
import type DatabaseType from "better-sqlite3";
import { campaignBreakdown } from "@/lib/reporting/breakdown";
import { lastDays } from "@/lib/reporting/range";

type DB = DatabaseType.Database;

export interface TemplateFigures {
  /** Times it was sent, and the contacts it went to (a contact in two campaigns counts in each). */
  sent: number;
  contacts: number;
  replied: number;
  positive: number;
  /** Steps that offer it now, and the campaigns those steps are in. */
  steps: number;
  campaigns: number;
  last_sent_at: string | null;
}

// A range nobody named counts sends for all time: only its `explicit: false` is read here.
const ALL_TIME = lastDays(30);
const blank = (): TemplateFigures => ({ sent: 0, contacts: 0, replied: 0, positive: 0, steps: 0, campaigns: 0, last_sent_at: null });

/** Figures for every template of a workspace that has been sent or is offered by a step. Others are simply absent. */
export function templateFigures(db: DB, workspaceId: string): Map<string, TemplateFigures> {
  const figures = new Map<string, TemplateFigures>();
  const of = (id: string) => {
    if (!figures.has(id)) figures.set(id, blank());
    return figures.get(id)!;
  };

  const workflows = db.prepare(
    "SELECT DISTINCT ss.workflow_id AS id FROM step_sends ss WHERE ss.workspace_id = ? AND ss.template_id IS NOT NULL AND ss.workflow_id IS NOT NULL",
  ).all(workspaceId) as Array<{ id: string }>;
  for (const workflow of workflows) {
    for (const row of campaignBreakdown(db, workflow.id, "template", ALL_TIME).rows) {
      if (row.key === "none") continue;
      const entry = of(row.key);
      entry.sent += row.sent;
      entry.contacts += row.contacts;
      entry.replied += row.replied;
      entry.positive += row.positive;
    }
  }

  const last = db.prepare(
    "SELECT template_id AS id, MAX(sent_at) AS at FROM step_sends WHERE workspace_id = ? AND template_id IS NOT NULL GROUP BY template_id",
  ).all(workspaceId) as Array<{ id: string; at: string | null }>;
  for (const row of last) of(row.id).last_sent_at = row.at;

  const offered = db.prepare(
    `SELECT wst.template_id AS id, COUNT(DISTINCT wst.step_id) AS steps, COUNT(DISTINCT ws.workflow_id) AS campaigns
     FROM workflow_step_templates wst JOIN workflow_steps ws ON ws.id = wst.step_id JOIN workflows w ON w.id = ws.workflow_id
     WHERE w.workspace_id = ? GROUP BY wst.template_id`,
  ).all(workspaceId) as Array<{ id: string; steps: number; campaigns: number }>;
  for (const row of offered) Object.assign(of(row.id), { steps: row.steps, campaigns: row.campaigns });

  return figures;
}

/** The campaigns whose steps offer a template, for saying what a change or a deletion touches. */
export function templateCampaigns(db: DB, workspaceId: string, templateId: string): Array<{ id: string; name: string; steps: number }> {
  return db.prepare(
    `SELECT w.id, w.name, COUNT(DISTINCT wst.step_id) AS steps
     FROM workflow_step_templates wst JOIN workflow_steps ws ON ws.id = wst.step_id JOIN workflows w ON w.id = ws.workflow_id
     WHERE w.workspace_id = ? AND wst.template_id = ? GROUP BY w.id ORDER BY w.name COLLATE NOCASE`,
  ).all(workspaceId, templateId) as Array<{ id: string; name: string; steps: number }>;
}
