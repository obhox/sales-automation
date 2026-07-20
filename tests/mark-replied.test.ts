import { describe, it, expect, beforeAll } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import handler from "@/pages/api/targets/[id]/mark-replied";

const WS = "ws-markreplied-1";
const OTHER_WS = "ws-markreplied-2";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

function mockReq(targetId: string, body: unknown, role = "member") {
  return {
    method: "POST",
    query: { id: targetId },
    body,
    headers: { "x-workspace-id": WS, "x-user-id": "user-1", "x-workspace-role": role },
  } as unknown as NextApiRequest;
}

let seq = 0;
function seedContact(workspaceId = WS) {
  const db = getDb();
  const n = ++seq;
  const targetId = `mr-tgt-${n}`;
  const runId = `mr-run-${n}`;
  const profileId = `mr-rp-${n}`;
  db.prepare("INSERT INTO targets (id, workspace_id, full_name) VALUES (?, ?, ?)").run(targetId, workspaceId, `Lead ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, NULL, 'running')").run(runId);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profileId, runId, targetId);
  for (const track of ["email", "linkedin"]) {
    db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, ?, 'in_progress')").run(
      `${profileId}-${track}`, profileId, track,
    );
  }
  return { targetId, profileId };
}

function states(profileId: string) {
  return (getDb().prepare("SELECT state FROM run_profile_tracks WHERE run_profile_id = ?").all(profileId) as Array<{ state: string }>).map(r => r.state);
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "MR WS", "mr-ws");
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(OTHER_WS, "Other WS", "mr-ws-2");
});

describe("POST /api/targets/[id]/mark-replied", () => {
  it("stops every track when a LinkedIn reply is recorded", () => {
    const { targetId, profileId } = seedContact();
    const res = mockRes();
    handler(mockReq(targetId, { channel: "linkedin" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.skipped_tracks).toBe(2);

    const row = getDb().prepare("SELECT last_replied_at, email_replied_at FROM targets WHERE id = ?").get(targetId) as {
      last_replied_at: string | null; email_replied_at: string | null;
    };
    // This is the column the runner's pre-step guard checks.
    expect(row.last_replied_at).not.toBeNull();
    expect(row.email_replied_at).toBeNull();
    expect(states(profileId)).toEqual(["skipped", "skipped"]);
  });

  it("defaults to the linkedin channel", () => {
    const { targetId } = seedContact();
    handler(mockReq(targetId, {}), mockRes());
    const row = getDb().prepare("SELECT last_replied_at FROM targets WHERE id = ?").get(targetId) as { last_replied_at: string | null };
    expect(row.last_replied_at).not.toBeNull();
  });

  it("records an email reply on the email column", () => {
    const { targetId } = seedContact();
    handler(mockReq(targetId, { channel: "email" }), mockRes());
    const row = getDb().prepare("SELECT last_replied_at, email_replied_at FROM targets WHERE id = ?").get(targetId) as {
      last_replied_at: string | null; email_replied_at: string | null;
    };
    expect(row.email_replied_at).not.toBeNull();
    expect(row.last_replied_at).toBeNull();
  });

  it("never overwrites an earlier reply timestamp", () => {
    const { targetId } = seedContact();
    const earlier = "2020-01-01T00:00:00.000Z";
    getDb().prepare("UPDATE targets SET last_replied_at = ? WHERE id = ?").run(earlier, targetId);
    handler(mockReq(targetId, { channel: "linkedin" }), mockRes());
    const row = getDb().prepare("SELECT last_replied_at FROM targets WHERE id = ?").get(targetId) as { last_replied_at: string };
    expect(row.last_replied_at).toBe(earlier);
  });

  it("does not leak across workspaces", () => {
    const { targetId } = seedContact(OTHER_WS);
    const res = mockRes();
    handler(mockReq(targetId, { channel: "linkedin" }), res);
    expect(res.statusCode).toBe(404);
    const row = getDb().prepare("SELECT last_replied_at FROM targets WHERE id = ?").get(targetId) as { last_replied_at: string | null };
    expect(row.last_replied_at).toBeNull();
  });

  it("rejects an unknown channel", () => {
    const { targetId } = seedContact();
    const res = mockRes();
    handler(mockReq(targetId, { channel: "carrier-pigeon" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a viewer without write permission", () => {
    const { targetId } = seedContact();
    const res = mockRes();
    handler(mockReq(targetId, { channel: "linkedin" }, "viewer"), res);
    expect(res.statusCode).toBe(403);
  });
});
