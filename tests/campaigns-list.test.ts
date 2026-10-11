// The campaigns list: one definition of a campaign's status, the figures on each row,
// filtering, sorting and paging, who owns a campaign, and actions on several at once.
// Real (throwaway) database.
import { describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, migrateDatabase } from "@/lib/db";

vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { campaignList, campaignStatus, campaignSummaries, type CampaignList } from "@/lib/campaigns/summary";
import { gatesOf, publishDraft } from "@/lib/outreach/publish";
import workflowsHandler from "@/pages/api/workflows/index";
import workflowHandler from "@/pages/api/workflows/[id]/index";
import bulkHandler from "@/pages/api/workflows/bulk";
import exportRoute from "@/pages/api/export/[resource]";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, text: "", destroyed: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  res.write = (chunk: string) => { res.text = String(res.text) + chunk; return true; };
  res.once = () => res;
  res.off = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown>; text: string };
}

function workspace() {
  const n = ++seq;
  const ws = `ws-camp-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const w = {
    ws,
    manager: ctxHeaders(ws, { userId: `camp-manager-${n}`, role: "manager" }),
    member: ctxHeaders(ws, { userId: `camp-member-${n}`, role: "member" }),
    viewer: ctxHeaders(ws, { userId: `camp-viewer-${n}`, role: "viewer" }),
    memberId: `camp-member-${n}`,
    /** A campaign with steps on the tracks named, owned by nobody unless said. */
    campaign(name: string, tracks: Array<"linkedin" | "email"> = ["linkedin"], fields: Record<string, unknown> = {}) {
      const id = `camp-wf-${++seq}`;
      db().prepare("INSERT INTO workflows (id, name, workspace_id, created_at) VALUES (?, ?, ?, datetime('now', ?))").run(id, name, ws, `-${100 - seq} minutes`);
      for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE workflows SET ${column} = ? WHERE id = ?`).run(value, id);
      publishDraft(db(), ws, id, {
        steps: tracks.map((track) => (track === "email" ? { step_type: "email" as const, email_subject: "Hi", email_body: "Hello" } : { step_type: "connect" as const })),
        gates: [],
      });
      return id;
    },
    list(name: string, contacts = 0) {
      const id = `camp-list-${++seq}`;
      db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, ?)").run(id, ws, name);
      for (let i = 0; i < contacts; i++) db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(id, w.contact());
      return id;
    },
    contact(fields: Record<string, unknown> = {}) {
      const id = `camp-target-${++seq}`;
      db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'Lead', ?)").run(id, ws, `https://www.linkedin.com/in/${id}/`);
      for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
      return id;
    },
    run(workflow: string, status: string, listId: string | null = null) {
      const id = `camp-run-${++seq}`;
      db().prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, status) VALUES (?, ?, ?, ?, ?)").run(id, ws, workflow, listId, status);
      return id;
    },
    /** Enrol a contact in a run with one track in the state given. */
    enrol(runId: string, target: string, state = "in_progress") {
      const profile = `camp-rp-${++seq}`;
      db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profile, runId, target);
      db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'linkedin', ?)").run(`camp-rt-${seq}`, profile, state);
    },
    send(workflow: string, target: string, action: string, when = "-1 hours") {
      db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, target_id, channel, action, sent_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))")
        .run(`camp-send-${++seq}`, ws, workflow, target, action === "email" ? "email" : "linkedin", action, when);
    },
  };
  return w;
}

const find = (ws: string, id: string) => campaignSummaries(db(), ws).find((campaign) => campaign.id === id)!;
const list = (ws: string, query: Partial<Parameters<typeof campaignList>[2]> = {}) => campaignList(db(), ws, { page: 1, limit: 25, ...query });

// ─────────────────────────────────────────────────────────────────────
describe("a campaign's status", () => {
  it("is one thing, read from its runs in a fixed order", () => {
    expect(campaignStatus(false, [])).toBe("draft");
    expect(campaignStatus(false, ["pending"])).toBe("draft");
    expect(campaignStatus(false, ["completed"])).toBe("completed");
    expect(campaignStatus(false, ["completed", "failed"])).toBe("completed");
    expect(campaignStatus(false, ["completed", "paused"])).toBe("paused");
    expect(campaignStatus(false, ["paused", "running", "completed"])).toBe("active");
    // A new list prepared on a finished campaign does not make it a draft again.
    expect(campaignStatus(false, ["completed", "pending"])).toBe("completed");
    expect(campaignStatus(true, ["running"])).toBe("archived");
  });

  it("gives a paused campaign a run to resume", () => {
    const w = workspace();
    const paused = w.campaign("Paused");
    const pausedRun = w.run(paused, "paused");
    const active = w.campaign("Active");
    w.run(active, "paused");
    const running = w.run(active, "running");
    const done = w.campaign("Done");
    w.run(done, "completed");

    expect(find(w.ws, paused)).toMatchObject({ status: "paused", run: { id: pausedRun, status: "paused" } });
    // With one running and one paused, pausing is what there is to do.
    expect(find(w.ws, active)).toMatchObject({ status: "active", run: { id: running, status: "running" } });
    expect(find(w.ws, done)).toMatchObject({ status: "completed", run: null });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the figures on a campaign's row", () => {
  it("says who it is going to, how far along it is, and on which channels", () => {
    const w = workspace();
    const both = w.campaign("Both", ["linkedin", "email"]);
    const listId = w.list("Enterprise VP Sales", 3);
    const runId = w.run(both, "running", listId);
    w.enrol(runId, w.contact(), "completed");
    w.enrol(runId, w.contact(), "skipped");
    w.enrol(runId, w.contact(), "in_progress");
    w.enrol(runId, w.contact(), "pending");

    expect(find(w.ws, both)).toMatchObject({
      channels: ["linkedin", "email"], steps: 2, gates: 0,
      list: { id: listId, name: "Enterprise VP Sales", contacts: 3 },
      enrolled: 4, done: 2,
    });
    expect(find(w.ws, w.campaign("Email only", ["email"]))).toMatchObject({ channels: ["email"], list: null, enrolled: 0, done: 0, reply_rate: null, acceptance_rate: null });
  });

  it("counts a reply only if it came after the campaign first wrote, and never an automatic one", () => {
    const w = workspace();
    const campaign = w.campaign("Replies", ["email"]);
    const answered = w.contact({ email_replied_at: new Date().toISOString() });
    const quiet = w.contact();
    const earlier = w.contact({ last_replied_at: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const away = w.contact({ email_replied_at: new Date().toISOString(), reply_kind: "out_of_office" });
    const visitedOnly = w.contact({ last_replied_at: new Date().toISOString() });
    for (const target of [answered, quiet, earlier, away]) w.send(campaign, target, "email");
    w.send(campaign, visitedOnly, "visit");

    // Four were written to (a visit is not writing); one of them answered this campaign.
    expect(find(w.ws, campaign)).toMatchObject({ contacted: 4, replied: 1, reply_rate: 0.25 });
  });

  it("measures acceptance on the contacts it invited", () => {
    const w = workspace();
    const campaign = w.campaign("Invites");
    const accepted = w.contact({ connected_at: new Date().toISOString() });
    const pending = w.contact();
    const messagedOnly = w.contact({ connected_at: new Date().toISOString() });
    w.send(campaign, accepted, "connect");
    w.send(campaign, accepted, "message");
    w.send(campaign, pending, "connect");
    w.send(campaign, messagedOnly, "message");
    expect(find(w.ws, campaign)).toMatchObject({ contacted: 3, invited: 2, accepted: 1, acceptance_rate: 0.5 });
  });

  it("dates its last activity by its last send, then its last start, then its creation", () => {
    const w = workspace();
    const sent = w.campaign("Sent");
    w.send(sent, w.contact(), "connect", "-3 hours");
    w.send(sent, w.contact(), "connect", "-30 minutes");
    const started = w.campaign("Started");
    db().prepare("UPDATE runs SET started_at = '2026-01-02 03:04:05' WHERE id = ?").run(w.run(started, "paused"));
    const fresh = w.campaign("Fresh");

    const minutesAgo = (value: string) => (Date.now() - Date.parse(`${value.replace(" ", "T")}Z`)) / 60_000;
    expect(minutesAgo(find(w.ws, sent).last_activity_at)).toBeGreaterThan(29);
    expect(minutesAgo(find(w.ws, sent).last_activity_at)).toBeLessThan(31);
    expect(find(w.ws, started).last_activity_at).toBe("2026-01-02 03:04:05");
    expect(find(w.ws, fresh).last_activity_at).toBe((db().prepare("SELECT created_at FROM workflows WHERE id = ?").get(fresh) as { created_at: string }).created_at);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("filtering, sorting and paging the list", () => {
  function several() {
    const w = workspace();
    const ids = {
      active: w.campaign("Alpha outreach", ["linkedin", "email"], { owner_id: w.memberId }),
      paused: w.campaign("Beta nurture", ["email"], { owner_id: w.memberId }),
      draft: w.campaign("Gamma draft", ["linkedin"]),
      completed: w.campaign("Delta wrap-up", ["linkedin"]),
      archived: w.campaign("Epsilon old", ["email"], { is_archived: 1 }),
    };
    w.run(ids.active, "running", w.list("VP Sales"));
    w.run(ids.paused, "paused");
    w.run(ids.completed, "completed");
    return { w, ids };
  }

  it("counts each tab, leaves archived campaigns out of All, and shows them only when asked", () => {
    const { w, ids } = several();
    const all = list(w.ws);
    expect(all.counts).toEqual({ all: 4, active: 1, paused: 1, draft: 1, completed: 1, archived: 1 });
    expect(all.total).toBe(4);
    expect(all.items.map((campaign) => campaign.id)).not.toContain(ids.archived);
    expect(list(w.ws, { status: "archived" }).items.map((campaign) => campaign.id)).toEqual([ids.archived]);
    expect(list(w.ws, { status: "paused" }).items.map((campaign) => campaign.id)).toEqual([ids.paused]);
    expect(list(w.ws, { status: "nonsense" }).total).toBe(4);
  });

  it("searches by campaign or list name, and filters by channel and owner, with the tabs counting what is left", () => {
    const { w, ids } = several();
    expect(list(w.ws, { q: "nurture" }).items.map((campaign) => campaign.id)).toEqual([ids.paused]);
    expect(list(w.ws, { q: "vp sales" }).items.map((campaign) => campaign.id)).toEqual([ids.active]);
    expect(list(w.ws, { channel: "email" }).counts).toMatchObject({ all: 2, active: 1, paused: 1, draft: 0, archived: 1 });
    expect(list(w.ws, { owner: w.memberId }).items.map((campaign) => campaign.id).sort()).toEqual([ids.active, ids.paused].sort());
    expect(list(w.ws, { owner: "none" }).counts.all).toBe(2);
    expect(list(w.ws).owners).toEqual([{ id: w.memberId, name: expect.any(String) }]);
  });

  it("sorts by what was asked and cuts pages on the sorted list", () => {
    const { w, ids } = several();
    const byName = list(w.ws, { sort: { key: "name", direction: "asc" } }).items.map((campaign) => campaign.name);
    expect(byName).toEqual(["Alpha outreach", "Beta nurture", "Delta wrap-up", "Gamma draft"]);
    const contact = w.contact();
    // The other campaigns' runs were created a moment ago; this send is later still.
    w.send(ids.draft, contact, "connect", "+1 minutes");
    expect(list(w.ws).items[0].id).toBe(ids.draft); // last activity, newest first, is the default
    // A campaign with nothing sent has no rate and sorts under every one that has.
    expect(list(w.ws, { sort: { key: "acceptance", direction: "desc" } }).items[0].id).toBe(ids.draft);

    const firstPage = list(w.ws, { sort: { key: "name", direction: "asc" }, page: 1, limit: 3 });
    const secondPage = list(w.ws, { sort: { key: "name", direction: "asc" }, page: 2, limit: 3 });
    expect(firstPage).toMatchObject({ total: 4, page: 1, limit: 3 });
    expect(firstPage.items).toHaveLength(3);
    expect(secondPage.items.map((campaign) => campaign.name)).toEqual(["Gamma draft"]);
  });

  it("is served to the screen as a list view, and to everyone else as it always was", async () => {
    const { w, ids } = several();
    const view = (await call(workflowsHandler, { method: "GET", query: { view: "list", status: "active", sort: "name:asc", limit: "10" }, headers: w.viewer })).body as unknown as CampaignList;
    expect(view).toMatchObject({ total: 1, page: 1, limit: 10, counts: { all: 4 } });
    expect(view.items[0]).toMatchObject({ id: ids.active, status: "active", channels: ["linkedin", "email"] });

    const plain = (await call(workflowsHandler, { method: "GET", headers: w.viewer })).body as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(plain)).toBe(true);
    expect(plain).toHaveLength(5);
    expect(plain[0]).toHaveProperty("step_count");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("who owns a campaign", () => {
  it("is whoever creates it, and can be changed to another member or to nobody", async () => {
    const w = workspace();
    const created = await call(workflowsHandler, { method: "POST", body: { name: "Mine" }, headers: w.member });
    const id = String(created.body.id);
    expect(find(w.ws, id).owner).toMatchObject({ id: w.memberId });

    const put = (owner_id: unknown) => call(workflowHandler, { method: "PUT", query: { id }, body: { owner_id }, headers: w.member });
    expect((await put("someone-else")).statusCode).toBe(400);
    await call(workflowsHandler, { method: "GET", headers: w.manager }); // makes the manager a member
    const managerId = w.memberId.replace("member", "manager");
    expect((await put(managerId)).statusCode).toBe(200);
    expect(find(w.ws, id).owner).toMatchObject({ id: managerId });
    expect((await put(null)).statusCode).toBe(200);
    expect(find(w.ws, id).owner).toBeNull();
    // Renaming does not touch the owner.
    await put(managerId);
    await call(workflowHandler, { method: "PUT", query: { id }, body: { name: "Renamed" }, headers: w.member });
    expect(find(w.ws, id)).toMatchObject({ name: "Renamed", owner: { id: managerId } });
  });

  it("is filled in once for campaigns that had none: their creator, else the workspace's owner", () => {
    const w = workspace();
    const ownerId = `camp-owner-${seq}`;
    ctxHeaders(w.ws, { userId: ownerId, role: "owner" });
    ctxHeaders(w.ws, { userId: w.memberId, role: "member" });
    const byMember = w.campaign("Created by a member");
    const unknown = w.campaign("Nobody on record");
    const outsider = w.campaign("Created by someone who has left");
    const kept = w.campaign("Already owned", ["linkedin"], { owner_id: w.memberId });
    const audit = (workflow: string, user: string) =>
      db().prepare("INSERT INTO audit_logs (id, workspace_id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, 'workflow.created', 'workflow', ?)").run(`camp-audit-${++seq}`, w.ws, user, workflow);
    audit(byMember, w.memberId);
    audit(outsider, "gone-user");

    db().prepare("DELETE FROM _migration_flags WHERE key = 'workflow_owner_v1'").run();
    migrateDatabase(db());

    const owner = (id: string) => (db().prepare("SELECT owner_id FROM workflows WHERE id = ?").get(id) as { owner_id: string | null }).owner_id;
    expect(owner(byMember)).toBe(w.memberId);
    expect(owner(unknown)).toBe(ownerId);
    expect(owner(outsider)).toBe(ownerId);
    expect(owner(kept)).toBe(w.memberId);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("acting on several campaigns at once", () => {
  const bulk = (headers: Record<string, string>, body: Record<string, unknown>) => call(bulkHandler, { method: "POST", body, headers });
  const statusOf = (id: string) => (db().prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;

  it("pauses what is running and resumes what is paused, answering for each campaign by itself", async () => {
    const w = workspace();
    const active = w.campaign("Active");
    const running = w.run(active, "running");
    const paused = w.campaign("Paused");
    const pausedRun = w.run(paused, "paused");
    const draft = w.campaign("Draft");

    const pausedNow = await bulk(w.manager, { action: "pause", ids: [active, paused, draft, "not-here"] });
    expect(pausedNow.body).toEqual({
      done: 1,
      results: [{ id: active, ok: true }, { id: paused, ok: false, error: "Nothing is running to pause" }, { id: draft, ok: false, error: "Nothing is running to pause" }, { id: "not-here", ok: false, error: "Not found" }],
    });
    expect(statusOf(running)).toBe("paused");

    const resumed = await bulk(w.manager, { action: "resume", ids: [active, paused] });
    expect(resumed.body.done).toBe(2);
    expect([statusOf(running), statusOf(pausedRun)]).toEqual(["running", "running"]);
    expect(ensureGlobalRunnerStarted).toHaveBeenCalled();
  });

  it("needs a manager to pause or resume, a member for the rest, and never reaches another workspace", async () => {
    const w = workspace();
    const other = workspace();
    const active = w.campaign("Active");
    const running = w.run(active, "running");
    expect((await bulk(w.member, { action: "pause", ids: [active] })).statusCode).toBe(403);
    expect((await bulk(w.viewer, { action: "archive", ids: [active] })).statusCode).toBe(403);
    expect((await bulk(other.manager, { action: "pause", ids: [active] })).body).toMatchObject({ done: 0, results: [{ ok: false, error: "Not found" }] });
    expect(statusOf(running)).toBe("running");
    expect((await bulk(w.manager, { action: "explode", ids: [active] })).statusCode).toBe(400);
    expect((await bulk(w.manager, { action: "pause", ids: [] })).statusCode).toBe(400);
  });

  it("will not archive a campaign that is still sending, and brings an archived one back", async () => {
    const w = workspace();
    const active = w.campaign("Active");
    w.run(active, "running");
    const done = w.campaign("Done");
    w.run(done, "completed");

    const archived = await bulk(w.member, { action: "archive", ids: [active, done] });
    expect(archived.body.results).toEqual([{ id: active, ok: false, error: "It is still running. Pause it first" }, { id: done, ok: true }]);
    expect(find(w.ws, active).status).toBe("active");
    expect(find(w.ws, done).status).toBe("archived");

    await bulk(w.member, { action: "unarchive", ids: [done] });
    expect(find(w.ws, done).status).toBe("completed");
  });

  it("duplicates each campaign whole, owned by whoever asked", async () => {
    const w = workspace();
    const source = w.campaign("Source", ["linkedin", "email"]);
    const connect = (db().prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_type = 'connect'").get(source) as { id: string }).id;
    publishDraft(db(), w.ws, source, {
      steps: [{ step_type: "connect", id: connect }, { step_type: "email", email_subject: "Hi", email_body: "Hello" }],
      gates: [{ source: connect, kind: "connected", on_false: { then: "handover_email" } }],
    });

    const res = await bulk(w.member, { action: "duplicate", ids: [source] });

    const copy = String((res.body.results as Array<{ new_id: string }>)[0].new_id);
    expect(find(w.ws, copy)).toMatchObject({ name: "Source (copy)", status: "draft", channels: ["linkedin", "email"], gates: 1, owner: { id: w.memberId } });
    expect(gatesOf(db(), copy)).toMatchObject([{ kind: "connected", on_false: { then: "handover_email" } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("taking the list out as a file", () => {
  it("holds the rows the screen was showing, for a manager", async () => {
    const w = workspace();
    const active = w.campaign("Alpha", ["linkedin", "email"], { owner_id: w.memberId });
    w.run(active, "running", w.list("VP Sales"));
    const invited = w.contact({ connected_at: new Date().toISOString() });
    w.send(active, invited, "connect");
    w.campaign("Beta", ["email"]);

    const res = await call(exportRoute, { method: "GET", query: { resource: "campaigns", status: "active" }, headers: w.manager });
    expect(res.statusCode).toBe(200);
    const lines = res.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Campaign,Status,Channels,List,Enrolled,Done,Contacted,Replied,Reply rate %,Invited,Accepted,Acceptance %,Owner,Last activity,Created");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Alpha,active,linkedin \+ email,VP Sales,0,0,1,0,0,1,1,100,/);
    expect((await call(exportRoute, { method: "GET", query: { resource: "campaigns" }, headers: w.member })).statusCode).toBe(403);
  });
});
