import { describe, it, expect, beforeAll, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import accountHandler from "@/pages/api/accounts/[id]";
import disconnectHandler from "@/pages/api/accounts/[id]/disconnect";

// The route tears down a live Playwright context before mutating. Stub it out so the test
// never launches a browser — the DB behaviour is what is under test here.
vi.mock("@/lib/linkedin/session", () => ({
  closeSession: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async (id: string) => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
  }),
}));

const WS = "ws-liacct-1";
const OTHER_WS = "ws-liacct-2";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

function mockReq(method: string, id: string) {
  return {
    method,
    query: { id },
    body: {},
    headers: { "x-workspace-id": WS, "x-user-id": "user-1", "x-workspace-role": "admin" },
  } as unknown as NextApiRequest;
}

let seq = 0;
/** An account plus one run in `status`, mirroring the real shape: run -> profile -> track. */
function seedAccount(status: string | null) {
  const db = getDb();
  const n = ++seq;
  const accountId = `li-acct-${n}`;
  db.prepare(
    "INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, ?, ?, 1, ?)"
  ).run(accountId, `Account ${n}`, `acct${n}@example.com`, WS);

  let runId: string | null = null;
  if (status) {
    runId = `li-run-${n}`;
    const workflowId = `li-wf-${n}`;
    db.prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(workflowId, `Campaign ${n}`, WS);
    db.prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, ?, ?)")
      .run(runId, workflowId, accountId, status, WS);
    db.prepare("INSERT INTO run_profiles (id, run_id) VALUES (?, ?)").run(`li-rp-${n}`, runId);
    db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'linkedin', 'in_progress')")
      .run(`li-rt-${n}`, `li-rp-${n}`);
  }
  return { accountId, runId };
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "LI Acct WS", "li-acct-ws");
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(OTHER_WS, "Other WS", "li-acct-ws-2");
});

describe("DELETE /api/accounts/[id]", () => {
  it("refuses while a campaign is running, and names it", async () => {
    // Deleting the account takes its runs with it. Silently ending live outreach is not an
    // acceptable side effect of a delete button.
    const { accountId } = seedAccount("running");
    const res = mockRes();
    await accountHandler(mockReq("DELETE", accountId), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.campaigns).toHaveLength(1);
    expect((res.body.campaigns as Array<{ name: string }>)[0].name).toMatch(/^Campaign /);
    // and the account is still there
    expect(getDb().prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)).toBeTruthy();
  });

  it("refuses while a campaign is pending", async () => {
    const { accountId } = seedAccount("pending");
    const res = mockRes();
    await accountHandler(mockReq("DELETE", accountId), res);
    expect(res.statusCode).toBe(409);
  });

  it("deletes once no campaign is active, taking its run history with it", async () => {
    // runs.account_id is a plain REFERENCES with no ON DELETE action and foreign_keys is ON,
    // so this used to fail outright for any account that had ever run a campaign.
    const { accountId, runId } = seedAccount("completed");
    const res = mockRes();
    await accountHandler(mockReq("DELETE", accountId), res);

    expect(res.statusCode).toBe(204);
    const db = getDb();
    expect(db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM runs WHERE id = ?").get(runId)).toBeUndefined();
    // cascade reached the rows under the run — no orphans left behind
    expect(db.prepare("SELECT id FROM run_profiles WHERE run_id = ?").get(runId)).toBeUndefined();
  });

  it("deletes an account that never ran a campaign", async () => {
    const { accountId } = seedAccount(null);
    const res = mockRes();
    await accountHandler(mockReq("DELETE", accountId), res);
    expect(res.statusCode).toBe(204);
  });

  it("404s for an account in another workspace", async () => {
    const { accountId } = seedAccount(null);
    getDb().prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?").run(OTHER_WS, accountId);
    const res = mockRes();
    await accountHandler(mockReq("DELETE", accountId), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/accounts/[id]/disconnect", () => {
  it("clears the session but keeps the account and its runs", async () => {
    // The reversible counterpart to delete: a running campaign is NOT a blocker, because
    // nothing is destroyed — the runner simply stops picking the account up.
    const { accountId, runId } = seedAccount("running");
    const res = mockRes();
    await disconnectHandler(mockReq("POST", accountId), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const account = db
      .prepare("SELECT is_authenticated, cookies_json FROM accounts WHERE id = ?")
      .get(accountId) as { is_authenticated: number; cookies_json: string | null };
    expect(account.is_authenticated).toBe(0);
    expect(account.cookies_json).toBeNull();
    expect(db.prepare("SELECT id FROM runs WHERE id = ?").get(runId)).toBeTruthy();
  });
});
