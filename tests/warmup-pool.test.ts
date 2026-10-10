// Warmup mail shows each side the other's sending address, so who a mailbox may be paired
// with is a tenancy question: its own workspace always, another workspace's mailboxes only
// while both workspaces leave the shared pool on. The send itself is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/email/infrastructure", async (original) => ({
  ...(await original<typeof import("@/lib/email/infrastructure")>()),
  sendEmailDurably: vi.fn(async () => ({ messageId: "<warmup@test.local>" })),
}));

import { processWarmupCycle } from "@/lib/platform/deliverability";
import { setWorkspaceSwitch } from "@/lib/workspace-settings";
import settingsHandler from "@/pages/api/platform/settings";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

function workspace(sharing?: boolean) {
  const id = `ws-warmup-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(id, id, id);
  if (sharing !== undefined) setWorkspaceSwitch(id, "warmup_shared_pool", sharing);
  return id;
}

/** A verified inbox, open all day, with warmup on. */
function inbox(ws: string) {
  const id = `warmup-inbox-${++seq}`;
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, active_hours_start, active_hours_end, timezone)
    VALUES (?, ?, ?, ?, 'smtp.test.com', 'user', 'pass', 1, 0, 24, 'UTC')`).run(id, ws, id, `${id}@example.com`);
  db().prepare(`INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate, started_at, updated_at)
    VALUES (?, ?, 1, 5, 60, datetime('now'), datetime('now'))`).run(id, ws);
  return id;
}

/** Who each inbox wrote to in the cycle just run, as "from>to". */
const pairs = () =>
  (db().prepare("SELECT from_account_id f, to_account_id t FROM warmup_messages ORDER BY f").all() as Array<{ f: string; t: string }>).map((m) => `${m.f}>${m.t}`);

// One scenario's inboxes must not be peers for the next.
beforeEach(() => {
  db().prepare("UPDATE warmup_settings SET enabled = 0").run();
  db().prepare("DELETE FROM warmup_messages").run();
});

describe("warmup pairing", () => {
  it("crosses workspaces while both leave the shared pool on, which is the default", async () => {
    const [a, b] = [inbox(workspace()), inbox(workspace())];
    await processWarmupCycle();
    expect(pairs()).toEqual([`${a}>${b}`, `${b}>${a}`].sort());
  });

  it("keeps a workspace that opted out to its own inboxes, in both directions", async () => {
    const outsider = inbox(workspace());
    const closed = workspace(false);
    const [first, second] = [inbox(closed), inbox(closed)];

    await processWarmupCycle();

    // The opted-out workspace still warms itself; nothing reaches it, or leaves it.
    expect(pairs()).toEqual([`${first}>${second}`, `${second}>${first}`].sort());
    expect(pairs().some((pair) => pair.includes(outsider))).toBe(false);
  });

  it("sends nothing for a lone inbox whose workspace opted out", async () => {
    inbox(workspace(false));
    inbox(workspace());
    await processWarmupCycle();
    expect(pairs()).toEqual([]);
  });

  it("resumes crossing workspaces once the switch is turned back on", async () => {
    const wsA = workspace(false);
    const [a, b] = [inbox(wsA), inbox(workspace())];
    await processWarmupCycle();
    expect(pairs()).toEqual([]);

    setWorkspaceSwitch(wsA, "warmup_shared_pool", true);
    await processWarmupCycle();
    expect(pairs()).toEqual([`${a}>${b}`, `${b}>${a}`].sort());
  });
});

describe("the workspace settings route", () => {
  function mockRes() {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
  }
  function call(req: Partial<NextApiRequest>) {
    const res = mockRes();
    settingsHandler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res);
    return res;
  }

  it("reports the shared pool as on until an admin turns it off, for that workspace only", () => {
    const [ws, other] = [workspace(), workspace()];
    const admin = ctxHeaders(ws, { userId: "warmup-admin", role: "admin" });
    expect(call({ method: "GET", headers: admin }).body).toEqual({ settings: { warmup_shared_pool: true } });

    expect(call({ method: "PUT", body: { warmup_shared_pool: false }, headers: admin }).body).toEqual({ settings: { warmup_shared_pool: false } });
    expect(call({ method: "GET", headers: ctxHeaders(other) }).body).toEqual({ settings: { warmup_shared_pool: true } });
  });

  it("refuses a member, an unknown setting and a value that is not true or false", () => {
    const ws = workspace();
    expect(call({ method: "PUT", body: { warmup_shared_pool: false }, headers: ctxHeaders(ws, { userId: "warmup-member", role: "member" }) }).statusCode).toBe(403);
    const admin = ctxHeaders(ws, { userId: "warmup-admin-2", role: "admin" });
    expect(call({ method: "PUT", body: { daily_import_cap: 5 }, headers: admin }).statusCode).toBe(400);
    expect(call({ method: "PUT", body: { warmup_shared_pool: "no" }, headers: admin }).statusCode).toBe(400);
    expect(call({ method: "GET", headers: admin }).body).toEqual({ settings: { warmup_shared_pool: true } });
  });
});
