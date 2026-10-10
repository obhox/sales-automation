// The triage a person does on a reply: who has it, where it stands, how it reads, when an
// answer is due, what it is filed under, and putting a wrong verdict right. Real
// (throwaway) database; nothing is sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn(async () => ({ messageId: "<x@test>" })) }));

import teamInbox from "@/pages/api/platform/inbox";
import inboxList, { type InboxReply } from "@/pages/api/inbox";
import reclassify from "@/pages/api/inbox/[replyId]/reclassify";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with one contact, in a campaign, who has replied. */
function replied(subject = "Re: Quick question", body = "Sounds interesting, tell me more.") {
  const n = ++seq;
  const ws = `ws-triage-${n}`;
  const r = { ws, target: `triage-target-${n}`, reply: `triage-reply-${n}`, email: `lee${n}@prospect.test`, headers: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, 'Lee Lead', ?, ?)").run(r.target, ws, r.email, `https://www.linkedin.com/in/triage-lead-${n}/`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(`triage-wf-${n}`, ws);
  db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(`triage-run-${n}`, `triage-wf-${n}`, ws);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`triage-rp-${n}`, `triage-run-${n}`, r.target);
  db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 1)").run(`triage-rt-${n}`, `triage-rp-${n}`);
  db().prepare(`INSERT INTO email_replies (id, workspace_id, target_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(r.reply, ws, r.target, r.email, subject, body);
  r.headers = ctxHeaders(ws, { userId: `triage-user-${n}`, role: "member" });
  return r;
}

const act = (r: { headers: Record<string, string> }, body: Record<string, unknown>) => call(teamInbox, { method: "POST", body, headers: r.headers });
const row = (id: string) => db().prepare("SELECT sentiment, sla_due_at, inbox_status, assigned_to FROM email_replies WHERE id = ?").get(id) as { sentiment: string | null; sla_due_at: string | null; inbox_status: string | null; assigned_to: string | null };
const listed = async (r: { headers: Record<string, string> }, query: Record<string, string> = {}) =>
  ((await call(inboxList, { method: "GET", query, headers: r.headers })).body.replies as InboxReply[]);
const suppressed = (ws: string, email: string) => Boolean(db().prepare("SELECT 1 FROM suppressions WHERE workspace_id = ? AND value = ?").get(ws, email));

beforeEach(() => { getDb(); });

describe("sentiment", () => {
  it("can be set and cleared by hand", async () => {
    const r = replied();
    expect((await act(r, { action: "set_sentiment", reply_id: r.reply, sentiment: "negative" })).statusCode).toBe(200);
    expect(row(r.reply).sentiment).toBe("negative");
    expect((await listed(r, { sentiment: "negative" })).map((x) => x.reply_id)).toEqual([r.reply]);

    await act(r, { action: "set_sentiment", reply_id: r.reply, sentiment: null });
    expect(row(r.reply).sentiment).toBeNull();
  });

  it("is refused when it is not one of the three", async () => {
    const r = replied();
    expect((await act(r, { action: "set_sentiment", reply_id: r.reply, sentiment: "furious" })).statusCode).toBe(400);
    expect(row(r.reply).sentiment).toBeNull();
  });
});

describe("when an answer is due", () => {
  it("is stored the way the overdue filter reads it, whatever shape it arrived in", async () => {
    const r = replied();
    const yesterday = new Date(Date.now() - 86_400_000);
    await act(r, { action: "set_sla", reply_id: r.reply, sla_due_at: yesterday.toISOString() });

    expect(row(r.reply).sla_due_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect((await listed(r, { sla: "overdue" })).map((x) => x.reply_id)).toEqual([r.reply]);

    await act(r, { action: "set_sla", reply_id: r.reply, sla_due_at: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await listed(r, { sla: "overdue" })).toEqual([]);
  });

  it("can be cleared, and is refused when it is not a date", async () => {
    const r = replied();
    await act(r, { action: "set_sla", reply_id: r.reply, sla_due_at: "2026-11-01T09:00:00Z" });
    expect((await act(r, { action: "set_sla", reply_id: r.reply, sla_due_at: "next tuesday-ish" })).statusCode).toBe(400);
    expect(row(r.reply).sla_due_at).toBe("2026-11-01 09:00:00");

    await act(r, { action: "set_sla", reply_id: r.reply, sla_due_at: null });
    expect(row(r.reply).sla_due_at).toBeNull();
  });
});

describe("tags", () => {
  it("are created, applied, filtered by, removed from a reply, renamed, recoloured and deleted", async () => {
    const r = replied();
    const other = replied();
    const created = await act(r, { action: "create_tag", name: "Pricing" });
    const tagId = String(created.body.id);

    await act(r, { action: "tag", reply_id: r.reply, tag_id: tagId });
    expect((await listed(r))[0].tags).toEqual([{ id: tagId, name: "Pricing", color: "#64748b" }]);
    expect((await listed(r, { tag_id: tagId })).map((x) => x.reply_id)).toEqual([r.reply]);
    // Another workspace's reply never carries it, and cannot be given it.
    expect((await act(other, { action: "tag", reply_id: other.reply, tag_id: tagId })).statusCode).toBe(400);

    expect((await act(r, { action: "update_tag", id: tagId, name: "Pricing question", color: "#0f766e" })).statusCode).toBe(200);
    expect((await listed(r))[0].tags).toEqual([{ id: tagId, name: "Pricing question", color: "#0f766e" }]);

    await act(r, { action: "untag", reply_id: r.reply, tag_id: tagId });
    expect((await listed(r))[0].tags).toEqual([]);

    await act(r, { action: "tag", reply_id: r.reply, tag_id: tagId });
    await act(r, { action: "delete_tag", id: tagId });
    expect((await listed(r))[0].tags).toEqual([]);
  });

  it("refuse a second tag of the same name, an empty name, and a colour that is not one", async () => {
    const r = replied();
    const first = String((await act(r, { action: "create_tag", name: "Hot" })).body.id);
    const second = String((await act(r, { action: "create_tag", name: "Warm" })).body.id);
    expect((await act(r, { action: "create_tag", name: "Hot" })).statusCode).toBe(409);
    expect((await act(r, { action: "update_tag", id: second, name: "Hot" })).statusCode).toBe(409);
    expect((await act(r, { action: "update_tag", id: first, name: "  " })).statusCode).toBe(400);
    expect((await act(r, { action: "update_tag", id: first, color: "red" })).statusCode).toBe(400);
    expect((await act(r, { action: "create_tag", name: "Cold", color: "javascript:alert(1)" })).statusCode).toBe(400);
  });

  it("cannot be renamed from another workspace", async () => {
    const r = replied();
    const other = replied();
    const tagId = String((await act(r, { action: "create_tag", name: "Ours" })).body.id);
    expect((await act(other, { action: "update_tag", id: tagId, name: "Theirs" })).statusCode).toBe(404);
    expect(db().prepare("SELECT name FROM inbox_tags WHERE id = ?").get(tagId)).toEqual({ name: "Ours" });
  });
});

describe("correcting a verdict by hand", () => {
  const verdictOf = (id: string) => JSON.parse((db().prepare("SELECT classification_json FROM email_replies WHERE id = ?").get(id) as { classification_json: string }).classification_json).kind as string;
  const correct = (r: { reply: string; headers: Record<string, string> }, kind?: string) =>
    call(reclassify, { method: "POST", query: { replyId: r.reply }, body: kind ? { override_kind: kind } : {}, headers: r.headers });

  it("sets the verdict and applies what follows from it", async () => {
    const r = replied("Re: Quick question", "Thanks, I have replied to your colleague.");
    expect((await correct(r, "unsubscribe")).statusCode).toBe(200);
    expect(verdictOf(r.reply)).toBe("unsubscribe");
    expect(suppressed(r.ws, r.email)).toBe(true);
  });

  it("undoes a suppression the wrong verdict caused", async () => {
    const r = replied("Re: Quick question", "Please remove me from your list.");
    await correct(r);
    expect(suppressed(r.ws, r.email)).toBe(true);

    await correct(r, "positive");
    expect(verdictOf(r.reply)).toBe("positive");
    expect(suppressed(r.ws, r.email)).toBe(false);
  });

  it("refuses a verdict that is not one", async () => {
    const r = replied();
    expect((await correct(r, "maybe")).statusCode).toBe(400);
  });
});
