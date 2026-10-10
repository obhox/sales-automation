// A campaign's sends split along one line: by step, by the mailbox or LinkedIn account that
// sent them, by message template, or by A/B version. Each row says how many went out and
// what came of them. Everything is read from step_sends, which records what each send used.
import type DatabaseType from "better-sqlite3";
import { AUTO_REPLY_KINDS, sqlList } from "@/lib/reply-kinds";
import type { ReportRange } from "@/lib/reporting/range";

type DB = DatabaseType.Database;

export const BREAKDOWNS = ["step", "sender", "linkedin_account", "template", "variant"] as const;
export type BreakdownBy = (typeof BREAKDOWNS)[number];
export const isBreakdown = (value: unknown): value is BreakdownBy => (BREAKDOWNS as readonly string[]).includes(String(value));

export interface BreakdownRow {
  key: string;
  label: string;
  /** A second line where the label alone is not enough: an address, a subject. */
  detail: string | null;
  channel: "email" | "linkedin";
  /** Sends, and the distinct contacts they went to. */
  sent: number;
  contacts: number;
  /** Emails a person (not a scanner) opened or clicked. */
  opened: number;
  clicked: number;
  /** Replies credited to these sends. */
  replied: number;
  /** Connection requests among the sends, and how many were accepted. */
  requests: number;
  accepted: number;
  /** For A/B versions: the step and version, and whether it has been paused. */
  step_id?: string;
  variant_id?: string | null;
  paused?: boolean;
}

// How sends are grouped, and which of them the grouping is about.
const GROUPING: Record<BreakdownBy, { key: string; where: string }> = {
  // History from before each send recorded its step is kept apart, by what kind of send it was.
  step: { key: "COALESCE(ss.step_id, 'action:' || ss.action)", where: "1 = 1" },
  sender: { key: "COALESCE(ss.email_account_id, 'none')", where: "ss.channel = 'email'" },
  linkedin_account: { key: "COALESCE(ss.account_id, 'none')", where: "ss.channel = 'linkedin'" },
  template: { key: "COALESCE(ss.template_id, 'none')", where: "ss.action IN ('message', 'inmail')" },
  variant: { key: "ss.step_id || '|' || COALESCE(ss.variant_id, 'control')", where: "ss.channel = 'email' AND ss.step_id IS NOT NULL" },
};

const ACTION_LABEL: Record<string, string> = { visit: "Profile visits", connect: "Connection requests", message: "LinkedIn messages", inmail: "InMails", email: "Emails" };
const STEP_LABEL: Record<string, string> = { visit: "Visit", connect: "Connect", message: "Message", sales_inmail: "InMail", email: "Email", delay: "Wait" };
const letter = (index: number) => String.fromCharCode(65 + index);

/**
 * Sends are counted in the period when one is named, for all time otherwise.
 *
 * A reply is credited to one send: an email reply to the email it answers (its In-Reply-To
 * names one of ours), or failing that to the last email the campaign sent that contact
 * before the reply came in; a LinkedIn reply to the last request or message before it.
 * Automatic answers (out-of-office and the like) are not counted.
 */
export function campaignBreakdown(db: DB, workflowId: string, by: BreakdownBy, range: ReportRange): { by: BreakdownBy; rows: BreakdownRow[] } {
  const RUNS = "SELECT id FROM runs WHERE workflow_id = @wf AND status IN ('running','paused','completed')";
  const lastTouch = (channel: string, target: string, before: string) => `(SELECT ss.id FROM step_sends ss
      WHERE ss.workflow_id = @wf AND ss.target_id = ${target} AND ${channel} AND datetime(ss.sent_at) <= datetime(${before})
      ORDER BY datetime(ss.sent_at) DESC, ss.rowid DESC LIMIT 1)`;
  const grouping = GROUPING[by];

  const groups = db.prepare(`
    WITH sends AS (
      SELECT ss.id, ss.target_id, ss.channel, ss.action, ss.email_job_id, ${grouping.key} AS grp
      FROM step_sends ss
      WHERE ss.workflow_id = @wf AND ${grouping.where}
        ${range.explicit ? "AND datetime(ss.sent_at) >= @from AND datetime(ss.sent_at) < @to" : ""}
    ),
    hits AS (
      SELECT sm.job_id,
        MAX(CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN 1 ELSE 0 END) AS opened,
        MAX(CASE WHEN se.event_type = 'clicked' AND se.is_bot = 0 THEN 1 ELSE 0 END) AS clicked
      FROM sent_messages sm JOIN sender_events se ON se.sent_message_id = sm.id AND se.event_type IN ('opened','clicked')
      WHERE sm.run_id IN (${RUNS})
      GROUP BY sm.job_id
    ),
    credited AS (
      SELECT send_id, COUNT(*) AS replies FROM (
        SELECT CASE
            WHEN er.in_reply_to_job_id IS NOT NULL THEN (SELECT ss.id FROM step_sends ss WHERE ss.email_job_id = er.in_reply_to_job_id AND ss.workflow_id = @wf)
            -- Naming none of ours, it goes to the last email before it, unless it was filed under another campaign.
            WHEN er.run_id IS NULL OR er.run_id IN (${RUNS}) THEN ${lastTouch("ss.channel = 'email'", "er.target_id", "er.received_at")}
          END AS send_id
        FROM email_replies er
        WHERE er.target_id IN (SELECT DISTINCT target_id FROM step_sends WHERE workflow_id = @wf AND channel = 'email')
          AND COALESCE(CASE WHEN json_valid(er.classification_json) THEN json_extract(er.classification_json, '$.kind') END, '') NOT IN (${sqlList(AUTO_REPLY_KINDS)})
        UNION ALL
        SELECT ${lastTouch("ss.channel = 'linkedin' AND ss.action IN ('connect', 'message', 'inmail')", "t.id", "t.last_replied_at")}
        FROM targets t
        WHERE t.last_replied_at IS NOT NULL
          AND t.id IN (SELECT DISTINCT target_id FROM step_sends WHERE workflow_id = @wf AND channel = 'linkedin')
      ) WHERE send_id IS NOT NULL GROUP BY send_id
    )
    SELECT s.grp, MIN(s.channel) AS channel, COUNT(*) AS sent, COUNT(DISTINCT s.target_id) AS contacts,
      COALESCE(SUM(h.opened), 0) AS opened, COALESCE(SUM(h.clicked), 0) AS clicked, COALESCE(SUM(c.replies), 0) AS replied,
      SUM(CASE WHEN s.action = 'connect' THEN 1 ELSE 0 END) AS requests,
      SUM(CASE WHEN s.action = 'connect' AND EXISTS (SELECT 1 FROM targets t WHERE t.id = s.target_id AND t.connected_at IS NOT NULL) THEN 1 ELSE 0 END) AS accepted
    FROM sends s LEFT JOIN hits h ON h.job_id = s.email_job_id LEFT JOIN credited c ON c.send_id = s.id
    GROUP BY s.grp
  `).all({ wf: workflowId, from: range.from, to: range.to }) as Array<Omit<BreakdownRow, "key" | "label" | "detail"> & { grp: string }>;

  const steps = new Map((db.prepare("SELECT id, track, step_order, step_type, email_subject, email_control_disabled FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as Array<{
    id: string; track: string; step_order: number; step_type: string; email_subject: string | null; email_control_disabled: number;
  }>).map((step) => [step.id, step]));
  const stepLabel = (id: string) => {
    const step = steps.get(id);
    return step ? `${step.track === "email" ? "Email" : "LinkedIn"} step ${step.step_order} · ${STEP_LABEL[step.step_type] ?? step.step_type}` : "A step since removed";
  };
  const named = (sql: string) => new Map((db.prepare(sql).all(workflowId) as Array<{ id: string; label: string; detail: string | null }>).map((row) => [row.id, row]));

  let describe: (key: string) => Partial<BreakdownRow> & { label: string; order?: number };
  if (by === "step") {
    describe = (key) => key.startsWith("action:")
      ? { label: `${ACTION_LABEL[key.slice(7)] ?? key.slice(7)}, step not recorded`, detail: "Sent before each send kept a note of its step", order: 1e6 }
      : { label: stepLabel(key), order: steps.has(key) ? (steps.get(key)!.track === "email" ? 1000 : 0) + steps.get(key)!.step_order : 1e5 };
  } else if (by === "sender" || by === "linkedin_account") {
    const accounts = named(by === "sender"
      ? "SELECT ea.id, ea.name AS label, ea.from_email AS detail FROM email_accounts ea WHERE ea.id IN (SELECT email_account_id FROM step_sends WHERE workflow_id = ?)"
      : "SELECT a.id, a.name AS label, a.email AS detail FROM accounts a WHERE a.id IN (SELECT account_id FROM step_sends WHERE workflow_id = ?)");
    const gone = by === "sender" ? "A mailbox since removed" : "A LinkedIn account since removed";
    describe = (key) => accounts.get(key) ?? { label: key === "none" ? "Not recorded" : gone };
  } else if (by === "template") {
    const templates = named("SELECT t.id, t.name AS label, NULL AS detail FROM templates t WHERE t.id IN (SELECT template_id FROM step_sends WHERE workflow_id = ?)");
    describe = (key) => templates.get(key) ?? { label: key === "none" ? "Written in the step" : "A template since removed" };
  } else {
    const variants = db.prepare(`SELECT v.id, v.step_id, v.subject, v.disabled_at,
        (SELECT COUNT(*) FROM workflow_step_email_variants o WHERE o.step_id = v.step_id AND o.position < v.position) AS place
      FROM workflow_step_email_variants v JOIN workflow_steps ws ON ws.id = v.step_id WHERE ws.workflow_id = ?`).all(workflowId) as Array<{ id: string; step_id: string; subject: string; disabled_at: string | null; place: number }>;
    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    describe = (key) => {
      const [stepId, variantKey] = key.split("|");
      const step = steps.get(stepId);
      const order = step ? step.step_order * 10 : 1e5;
      if (variantKey === "control") return { label: `${stepLabel(stepId)} · A`, detail: step?.email_subject ?? null, step_id: stepId, variant_id: null, paused: Boolean(step?.email_control_disabled), order };
      const variant = byId.get(variantKey);
      // A version edited out of the step keeps its sends but no longer has a letter.
      return variant
        ? { label: `${stepLabel(stepId)} · ${letter(variant.place + 1)}`, detail: variant.subject, step_id: stepId, variant_id: variant.id, paused: Boolean(variant.disabled_at), order: order + variant.place + 1 }
        : { label: `${stepLabel(stepId)} · a version since removed`, step_id: stepId, variant_id: variantKey, paused: true, order: order + 9 };
    };
  }

  const rows = groups.map(({ grp, ...figures }) => {
    const { order, ...described } = describe(grp);
    return { order, row: { key: grp, detail: null, ...described, ...figures } as BreakdownRow };
  });
  // Steps and versions in the campaign's own order; everything else busiest first.
  rows.sort((a, b) => (a.order !== undefined || b.order !== undefined ? (a.order ?? 0) - (b.order ?? 0) : b.row.sent - a.row.sent));
  return { by, rows: rows.map((entry) => entry.row) };
}
