// What a campaign step used and did, written down: the template picked from a pool (and
// picked again, identically, on a retry), the A/B variant an email went out with, and the
// variant ids surviving a save. The engine runs against a real (throwaway) database with
// the browser and the SMTP send stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/connect", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/connect")>()), sendConnectionRequest: vi.fn(async () => ({ noteSent: false, noteSkipped: null })) }));
vi.mock("@/lib/linkedin/message", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/message")>()), sendMessage: vi.fn() }));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, _to: string, _subject: string, _body: string, options: { messageId: string }) => ({ messageId: options.messageId }),
}));

import { tick } from "@/lib/linkedin/runner";
import { sendMessage } from "@/lib/linkedin/message";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import stepsHandler from "@/pages/api/workflows/[id]/steps";
import winnerHandler from "@/pages/api/workflows/[id]/steps/[stepId]/winner";
import { ctxHeaders } from "./helpers/ctx";

const message = vi.mocked(sendMessage);
const db = () => getDb();
let seq = 0;

type StepSpec = { type: "visit" | "connect" | "message" | "email"; body?: string; templates?: string[]; variants?: string[] };

function campaign(steps: StepSpec[]) {
  const n = ++seq;
  const ws = `ws-sends-${n}`;
  const c = { ws, run: `sends-run-${n}`, workflow: `sends-wf-${n}`, account: `sends-li-${n}`, mailbox: `sends-mailbox-${n}`, steps: [] as string[], templates: [] as string[] };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.account, `sends${n}@example.com`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(c.workflow, ws);
  const order: Record<string, number> = {};
  for (const step of steps) {
    const track = step.type === "email" ? "email" : "linkedin";
    order[track] = (order[track] ?? 0) + 1;
    const id = `sends-step-${n}-${track}-${order[track]}`;
    c.steps.push(id);
    db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body, email_subject, email_body)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, c.workflow, order[track], track, step.type, step.type === "message" ? step.body ?? null : null,
      step.type === "email" ? "Control subject" : null, step.type === "email" ? step.body ?? "Control body" : null);
    for (const body of step.templates ?? []) {
      const templateId = `sends-tmpl-${++seq}`;
      c.templates.push(templateId);
      db().prepare("INSERT INTO templates (id, workspace_id, name, body) VALUES (?, ?, ?, ?)").run(templateId, ws, templateId, body);
      db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(id, templateId);
    }
    (step.variants ?? []).forEach((body, i) => {
      db().prepare("INSERT INTO workflow_step_email_variants (id, step_id, subject, body, position) VALUES (?, ?, ?, ?, ?)").run(`sends-variant-${++seq}`, id, `Variant subject ${i}`, body, i);
    });
  }
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(c.run, c.workflow, c.account, ws);
  const enrol = () => {
    const k = ++seq;
    const target = `sends-target-${k}`;
    db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, email, email_status, email_verified_at, linkedin_url, degree, connected_at)
      VALUES (?, ?, ?, 'Lee', ?, 'verified', datetime('now'), ?, 1, datetime('now'))`).run(target, ws, `Lead ${k}`, `lead${k}@prospect.test`, `https://www.linkedin.com/in/sends-lead-${k}/`);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`sends-rp-${k}`, c.run, target, c.mailbox);
    for (const track of Object.keys(order)) {
      db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'in_progress', 0)").run(`sends-rt-${k}-${track}`, `sends-rp-${k}`, track);
    }
    return target;
  };
  return { ...c, enrol };
}

const sends = (run: string) =>
  db().prepare("SELECT step_id, target_id, channel, action, account_id, email_account_id, template_id, variant_id, email_job_id FROM step_sends WHERE run_id = ? ORDER BY rowid").all(run) as Array<Record<string, string | null>>;

async function run() {
  db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress'").run();
  await tick(getDb(), { pace: false });
}

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  vi.clearAllMocks();
  message.mockResolvedValue("sent");
});

describe("a message step with a pool of templates", () => {
  it("sends the same template again when the first attempt fails", async () => {
    const c = campaign([{ type: "message", templates: ["Pool message one", "Pool message two", "Pool message three", "Pool message four"] }]);
    c.enrol();
    message.mockRejectedValueOnce(new Error("LinkedIn was slow"));

    await run();
    await run();

    expect(message).toHaveBeenCalledTimes(2);
    expect(message.mock.calls[1][2]).toBe(message.mock.calls[0][2]);
  });

  it("writes down which template went out", async () => {
    const c = campaign([{ type: "message", templates: ["Pool message one", "Pool message two", "Pool message three"] }]);
    const target = c.enrol();

    await run();

    const [row] = sends(c.run);
    expect(row).toMatchObject({ step_id: c.steps[0], target_id: target, channel: "linkedin", action: "message", account_id: c.account });
    const sentText = message.mock.calls[0][2];
    expect(db().prepare("SELECT body FROM templates WHERE id = ?").get(row.template_id)).toEqual({ body: sentText });
  });

  it("does not give every contact the same one", async () => {
    const c = campaign([{ type: "message", templates: ["Pool message one", "Pool message two", "Pool message three"] }]);
    for (let i = 0; i < 12; i++) c.enrol();

    await run();

    expect(new Set(message.mock.calls.map((call) => call[2])).size).toBeGreaterThan(1);
  });

  it("records nothing for a message that was already there from an earlier attempt", async () => {
    const c = campaign([{ type: "message", body: "Hi Lee" }]);
    c.enrol();
    message.mockResolvedValue("already_sent");

    await run();

    expect(sends(c.run)).toEqual([]);
  });
});

describe("the other steps", () => {
  it("record a visit and an invitation against the LinkedIn account that made them", async () => {
    const c = campaign([{ type: "visit" }, { type: "connect" }]);
    const target = c.enrol();
    db().prepare("UPDATE targets SET degree = 2, connected_at = NULL WHERE id = ?").run(target);

    await run();
    await run();

    expect(sends(c.run).map((row) => [row.action, row.step_id, row.account_id])).toEqual([["visit", c.steps[0], c.account], ["connect", c.steps[1], c.account]]);
  });

  it("record an email with its mailbox, the variant it used and the job that sent it", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const target = c.enrol();

    await run();

    const [row] = sends(c.run);
    const job = db().prepare("SELECT id, variant_id FROM email_jobs WHERE run_id = ?").get(c.run) as { id: string; variant_id: string | null };
    expect(row).toMatchObject({ step_id: c.steps[0], target_id: target, channel: "email", action: "email", account_id: null, email_account_id: c.mailbox, email_job_id: job.id, variant_id: job.variant_id });
  });

  it("split contacts across the email variants", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    for (let i = 0; i < 18; i++) c.enrol();
    // One mailbox paces its sends, so each run of the engine lets one email out.
    for (let i = 0; i < 18; i++) {
      db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day') WHERE message LIKE 'Email sent%'").run();
      await run();
    }

    const used = new Set(sends(c.run).map((row) => row.variant_id));
    expect(sends(c.run)).toHaveLength(18);
    expect(used.size).toBeGreaterThan(1);
  });
});

describe("saving a campaign's steps", () => {
  function put(workflowId: string, ws: string, steps: unknown[]) {
    const res: Record<string, unknown> = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    stepsHandler({ method: "PUT", query: { id: workflowId }, body: { steps }, headers: ctxHeaders(ws) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res.statusCode;
  }
  const variants = (stepId: string) =>
    db().prepare("SELECT id, subject, body FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position").all(stepId) as Array<{ id: string; subject: string; body: string }>;

  it("keeps each variant's id, so its results stay in one place", () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const before = variants(c.steps[0]);

    expect(put(c.workflow, c.ws, [{
      step_type: "email", track: "email", email_subject: "Control subject", email_body: "Control body",
      email_variants: [{ id: before[0].id, subject: "Reworded subject", body: "Variant body one" }, { id: before[1].id, subject: before[1].subject, body: before[1].body }],
    }])).toBe(200);

    const after = variants(c.steps[0]);
    expect(after.map((v) => v.id)).toEqual(before.map((v) => v.id));
    expect(after[0].subject).toBe("Reworded subject");
  });

  it("adds a new variant, drops a removed one, and leaves the rest alone", () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const before = variants(c.steps[0]);

    put(c.workflow, c.ws, [{
      step_type: "email", track: "email", email_subject: "Control subject", email_body: "Control body",
      email_variants: [{ id: before[1].id, subject: before[1].subject, body: before[1].body }, { id: null, subject: "Brand new", body: "New body" }],
    }]);

    const after = variants(c.steps[0]);
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(before[1].id);
    expect(after[1]).toMatchObject({ subject: "Brand new" });
    expect(after.map((v) => v.id)).not.toContain(before[0].id);
  });

  it("does not adopt an id that belongs to another step", () => {
    const a = campaign([{ type: "email", variants: ["A's variant"] }]);
    const b = campaign([{ type: "email" }]);
    const foreign = variants(a.steps[0])[0].id;

    put(b.workflow, b.ws, [{ step_type: "email", track: "email", email_subject: "s", email_body: "b", email_variants: [{ id: foreign, subject: "Hijack", body: "x" }] }]);

    expect(variants(a.steps[0])[0]).toMatchObject({ id: foreign, body: "A's variant" });
    expect(variants(b.steps[0])[0].id).not.toBe(foreign);
  });
});

describe("a contact's custom fields", () => {
  it("include the ones the workspace defines but this contact has no value for", () => {
    const c = campaign([{ type: "visit" }]);
    const target = c.enrol();
    db().prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type) VALUES ('sends-field-1', ?, 'Pain point', 'pain_point', 'text'), ('sends-field-2', ?, 'Budget', 'budget', 'number')").run(c.ws, c.ws);
    db().prepare("INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text) VALUES (?, ?, 'sends-field-1', 'churn')").run(c.ws, target);

    expect(loadTargetCustomValues(getDb(), c.ws, target)).toEqual({ pain_point: "churn", budget: "" });
  });
});

describe("an A/B test that has been ended", () => {
  async function choose(c: { workflow: string; ws: string; steps: string[] }, body: Record<string, unknown>, headers = ctxHeaders(c.ws), stepId = c.steps[0]) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    await winnerHandler({ method: "POST", query: { id: c.workflow, stepId }, body, headers } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: { control_paused: boolean; variants: Array<{ id: string; disabled_at: string | null }> } };
  }
  const variantIds = (stepId: string) => (db().prepare("SELECT id FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position").all(stepId) as Array<{ id: string }>).map((row) => row.id);
  const paused = (stepId: string) => ({
    control: (db().prepare("SELECT email_control_disabled c FROM workflow_steps WHERE id = ?").get(stepId) as { c: number }).c === 1,
    variants: (db().prepare("SELECT disabled_at FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position").all(stepId) as Array<{ disabled_at: string | null }>).map((row) => row.disabled_at !== null),
  });
  async function sendTo(c: ReturnType<typeof campaign>, contacts: number) {
    for (let i = 0; i < contacts; i++) c.enrol();
    for (let i = 0; i < contacts; i++) {
      db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day') WHERE message LIKE 'Email sent%'").run();
      await run();
    }
    return sends(c.run).map((row) => row.variant_id);
  }

  it("sends only the winning version from then on", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const [, second] = variantIds(c.steps[0]);
    const res = await choose(c, { variant_id: second });
    expect(res.statusCode).toBe(200);
    expect(res.body.control_paused).toBe(true);
    expect(paused(c.steps[0])).toEqual({ control: true, variants: [true, false] });

    const used = await sendTo(c, 12);
    expect(used).toHaveLength(12);
    expect(new Set(used)).toEqual(new Set([second]));
  });

  it("sends only the original wording when that is the winner", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    await choose(c, { variant_id: null });
    expect(paused(c.steps[0])).toEqual({ control: false, variants: [true, true] });
    expect(new Set(await sendTo(c, 8))).toEqual(new Set([null]));
  });

  it("goes back to every version when the test is reopened", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    await choose(c, { variant_id: variantIds(c.steps[0])[0] });
    await choose(c, { clear: true });
    expect(paused(c.steps[0])).toEqual({ control: false, variants: [false, false] });
    expect(new Set(await sendTo(c, 18)).size).toBeGreaterThan(1);
  });

  it("keeps the first pause time of a version that was already paused", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const [first, second] = variantIds(c.steps[0]);
    await choose(c, { variant_id: null });
    db().prepare("UPDATE workflow_step_email_variants SET disabled_at = '2026-01-01 00:00:00' WHERE id = ?").run(first);
    await choose(c, { variant_id: second });
    expect(db().prepare("SELECT disabled_at FROM workflow_step_email_variants WHERE id = ?").get(first)).toEqual({ disabled_at: "2026-01-01 00:00:00" });
  });

  it("refuses a version from another step, a step with no test, and a request that names nothing", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one"] }, { type: "email" }]);
    const other = campaign([{ type: "email", variants: ["Theirs"] }]);
    expect((await choose(c, { variant_id: variantIds(other.steps[0])[0] })).statusCode).toBe(400);
    expect((await choose(c, { variant_id: null }, ctxHeaders(c.ws), c.steps[1])).statusCode).toBe(400);
    expect((await choose(c, {})).statusCode).toBe(400);
    expect(paused(c.steps[0])).toEqual({ control: false, variants: [false] });
  });

  it("is not open to a viewer or to another workspace", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one"] }]);
    const other = campaign([{ type: "email", variants: ["Theirs"] }]);
    expect((await choose(c, { variant_id: null }, ctxHeaders(c.ws, { userId: `viewer-${c.ws}`, role: "viewer" }))).statusCode).toBe(403);
    expect((await choose(c, { variant_id: null }, ctxHeaders(other.ws))).statusCode).toBe(404);
    expect(paused(c.steps[0])).toEqual({ control: false, variants: [false] });
  });

  it("still sends if every version has somehow been paused", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one"] }]);
    db().prepare("UPDATE workflow_steps SET email_control_disabled = 1 WHERE id = ?").run(c.steps[0]);
    db().prepare("UPDATE workflow_step_email_variants SET disabled_at = datetime('now') WHERE step_id = ?").run(c.steps[0]);
    expect(await sendTo(c, 3)).toHaveLength(3);
  });

  it("survives the campaign being saved again, until the winning version is edited out", async () => {
    const c = campaign([{ type: "email", variants: ["Variant body one", "Variant body two"] }]);
    const [first, second] = variantIds(c.steps[0]);
    await choose(c, { variant_id: second });
    const save = (email_variants: unknown[]) => {
      const res: Record<string, unknown> = { statusCode: 200 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = () => res;
      stepsHandler({ method: "PUT", query: { id: c.workflow }, body: { steps: [{ step_type: "email", track: "email", email_subject: "Control subject", email_body: "Control body", email_variants }] }, headers: ctxHeaders(c.ws) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    };

    save([{ id: first, subject: "Reworded", body: "Variant body one" }, { id: second, subject: "Variant subject 1", body: "Variant body two" }]);
    expect(paused(c.steps[0])).toEqual({ control: true, variants: [true, false] });

    // With the winner removed nothing would be left sending, so the original comes back.
    save([{ id: first, subject: "Reworded", body: "Variant body one" }]);
    expect(paused(c.steps[0])).toEqual({ control: false, variants: [true] });
  });
});
