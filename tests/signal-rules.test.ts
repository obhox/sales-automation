// Signal rules as they are written and edited: what a rule must name before it can work,
// what happens when something it named is deleted, and who may change them. Real
// (throwaway) database.
import { describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

import rules from "@/pages/api/platform/signal-rules";
import { ingestSignal } from "@/lib/platform/signals";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await rules({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with a list, a contact, a LinkedIn account, a mailbox, and one campaign of each kind. */
function workspace() {
  const n = ++seq;
  const ws = `ws-rule-${n}`;
  const w = {
    ws, list: `rule-list-${n}`, target: `rule-target-${n}`, account: `rule-li-${n}`, mailbox: `rule-mailbox-${n}`,
    linkedinCampaign: `rule-wf-li-${n}`, emailCampaign: `rule-wf-email-${n}`,
    manager: {} as Record<string, string>, member: {} as Record<string, string>,
  };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Funded')").run(w.list, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, 'Lee Lead', ?, ?)").run(w.target, ws, `lee${n}@prospect.test`, `https://www.linkedin.com/in/rule-lead-${n}/`);
  db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'LinkedIn', ?, 1, ?)").run(w.account, `rule${n}@example.com`, ws);
  db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass')").run(w.mailbox, ws, `ada${n}@acme.test`);
  for (const [id, track, type] of [[w.linkedinCampaign, "linkedin", "visit"], [w.emailCampaign, "email", "email"]]) {
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(id, `${track} campaign`, ws);
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body) VALUES (?, ?, 1, ?, ?, 0, ?, ?)")
      .run(`${id}-step`, id, track, type, type === "email" ? "Quick question" : null, type === "email" ? "Hello" : null);
  }
  w.manager = ctxHeaders(ws, { userId: `rule-manager-${n}`, role: "manager" });
  w.member = ctxHeaders(ws, { userId: `rule-member-${n}`, role: "member" });
  return w;
}

type W = ReturnType<typeof workspace>;
const post = (w: W, body: Record<string, unknown>, headers = w.manager) => call({ method: "POST", headers, body: { name: "Funding", signal_type: "funding", ...body } });
const patch = (w: W, body: Record<string, unknown>) => call({ method: "PATCH", headers: w.manager, body });
const listed = async (w: W) => (await call({ method: "GET", headers: w.member })).body as unknown as Array<Record<string, unknown>>;

describe("writing a rule", () => {
  it("may only add to a list", async () => {
    const w = workspace();
    const res = await post(w, { list_id: w.list, min_score: 40 });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ list_id: w.list, workflow_id: null, min_score: 40, enabled: 1, auto_start: 0 });
  });

  it("is refused when it would do nothing", async () => {
    const w = workspace();
    const res = await post(w, {});
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/list, a campaign, or both/);
  });

  it("needs a list to enrol into a campaign", async () => {
    const w = workspace();
    const res = await post(w, { workflow_id: w.linkedinCampaign, account_id: w.account });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/needs a list/);
  });

  it("needs a LinkedIn account for a campaign with LinkedIn steps, and a mailbox does not stand in", async () => {
    const w = workspace();
    const res = await post(w, { list_id: w.list, workflow_id: w.linkedinCampaign, email_account_id: w.mailbox });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/LinkedIn account/);
    expect((await post(w, { list_id: w.list, workflow_id: w.linkedinCampaign, account_id: w.account })).statusCode).toBe(201);
  });

  it("needs a mailbox for an email-only campaign, and a LinkedIn account does not stand in", async () => {
    const w = workspace();
    const res = await post(w, { list_id: w.list, workflow_id: w.emailCampaign, account_id: w.account });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/mailbox/);
    expect((await post(w, { list_id: w.list, workflow_id: w.emailCampaign, email_account_id: w.mailbox })).statusCode).toBe(201);
  });

  it("refuses a kind of signal that does not exist, which could never match", async () => {
    const w = workspace();
    expect((await post(w, { list_id: w.list, signal_type: "funding_round" })).statusCode).toBe(400);
    expect((await post(w, { list_id: w.list, min_score: -1 })).statusCode).toBe(400);
  });

  it("refuses a list, campaign or account from another workspace", async () => {
    const w = workspace();
    const other = workspace();
    expect((await post(w, { list_id: other.list })).statusCode).toBe(400);
    expect((await post(w, { list_id: w.list, workflow_id: other.linkedinCampaign, account_id: w.account })).statusCode).toBe(400);
    expect((await post(w, { list_id: w.list, workflow_id: w.linkedinCampaign, account_id: other.account })).statusCode).toBe(400);
    expect((await post(w, { list_id: w.list, workflow_id: w.emailCampaign, email_account_id: other.mailbox })).statusCode).toBe(400);
  });

  it("is a manager's to write, and anyone's to read", async () => {
    const w = workspace();
    expect((await post(w, { list_id: w.list }, w.member)).statusCode).toBe(403);
    await post(w, { list_id: w.list });
    expect(await listed(w)).toHaveLength(1);
  });
});

describe("changing a rule", () => {
  it("is checked as the rule would stand afterwards", async () => {
    const w = workspace();
    const id = String((await post(w, { list_id: w.list, workflow_id: w.linkedinCampaign, account_id: w.account })).body.id);
    // Swapping to the email campaign without a mailbox leaves it with nothing to send from.
    expect((await patch(w, { id, workflow_id: w.emailCampaign })).statusCode).toBe(400);
    expect((await patch(w, { id, workflow_id: w.emailCampaign, email_account_id: w.mailbox })).statusCode).toBe(200);
    expect((await patch(w, { id, list_id: null })).statusCode).toBe(400);
    expect((await listed(w))[0]).toMatchObject({ workflow_id: w.emailCampaign, email_account_id: w.mailbox, list_id: w.list, problem: null });
  });

  it("can be turned off and on, edited and deleted", async () => {
    const w = workspace();
    const id = String((await post(w, { list_id: w.list })).body.id);
    await patch(w, { id, enabled: false, name: "Funding rounds", min_score: 60, auto_start: true });
    expect((await listed(w))[0]).toMatchObject({ enabled: 0, name: "Funding rounds", min_score: 60, auto_start: 1 });
    expect((await call({ method: "DELETE", headers: w.manager, query: { id } })).statusCode).toBe(204);
    expect(await listed(w)).toHaveLength(0);
    expect((await call({ method: "DELETE", headers: w.manager, query: { id } })).statusCode).toBe(404);
  });

  it("cannot be done to another workspace's rule", async () => {
    const w = workspace();
    const other = workspace();
    const id = String((await post(w, { list_id: w.list })).body.id);
    expect((await patch(other, { id, enabled: false })).statusCode).toBe(404);
    expect((await call({ method: "DELETE", headers: other.manager, query: { id } })).statusCode).toBe(404);
    expect((await listed(w))[0]).toMatchObject({ enabled: 1 });
  });
});

describe("a rule whose account was deleted after it was written", () => {
  async function orphaned() {
    const w = workspace();
    const id = String((await post(w, { list_id: w.list, workflow_id: w.linkedinCampaign, account_id: w.account })).body.id);
    db().prepare("DELETE FROM accounts WHERE id = ?").run(w.account);
    return { w, id };
  }

  it("is listed with what is wrong with it", async () => {
    const { w } = await orphaned();
    expect(String((await listed(w))[0].problem)).toMatch(/LinkedIn account/);
  });

  it("enrols nobody, though it still adds the contact to its list", async () => {
    const { w } = await orphaned();
    ingestSignal({ workspaceId: w.ws, targetId: w.target, type: "funding", title: "Raised a round", score: 50 });
    expect(db().prepare("SELECT COUNT(*) c FROM runs WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(db().prepare("SELECT COUNT(*) c FROM list_targets WHERE list_id = ? AND target_id = ?").get(w.list, w.target)).toEqual({ c: 1 });
  });

  it("can be turned off as it is, but not back on until it is put right", async () => {
    const { w, id } = await orphaned();
    expect((await patch(w, { id, enabled: false })).statusCode).toBe(200);
    expect((await patch(w, { id, enabled: true })).statusCode).toBe(400);
    expect((await patch(w, { id, enabled: true, workflow_id: null })).statusCode).toBe(200);
  });
});

describe("a rule that is in order", () => {
  it("enrols the contact a matching signal is about, waiting to be started", async () => {
    const w = workspace();
    await post(w, { list_id: w.list, workflow_id: w.emailCampaign, email_account_id: w.mailbox, min_score: 40 });
    ingestSignal({ workspaceId: w.ws, targetId: w.target, type: "funding", title: "Seed", score: 30 });
    expect(db().prepare("SELECT COUNT(*) c FROM runs WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });

    ingestSignal({ workspaceId: w.ws, targetId: w.target, type: "funding", title: "Series A", score: 50 });
    const run = db().prepare("SELECT id, status, email_account_id FROM runs WHERE workspace_id = ?").get(w.ws) as { id: string; status: string; email_account_id: string };
    expect(run).toMatchObject({ status: "pending", email_account_id: w.mailbox });
    expect(db().prepare("SELECT COUNT(*) c FROM run_profiles WHERE run_id = ? AND target_id = ?").get(run.id, w.target)).toEqual({ c: 1 });
  });
});
