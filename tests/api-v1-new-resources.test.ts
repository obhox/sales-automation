import { describe, it, expect, beforeAll } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import handler from "@/pages/api/v1/[...path]";

/**
 * Covers the resources added to the public v1 API so Falorb's mirror has
 * everything the integration plan needs: signal_rules (so a caller can show
 * *why* a signal will fire before ingesting one), pipeline_stages,
 * suppressions (checked before acting on anyone), sent_messages, and the
 * relationship resources run_profiles / list_members.
 */

const WS = "ws-v1-new-0001";
const OTHER_WS = "ws-v1-new-0002";

let readKey: string;
let noScopeKey: string;
let listId: string;
let runId: string;
let targetId: string;

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "V1 WS", "v1-ws");
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(OTHER_WS, "Other WS", "other-ws");

  readKey = createApiKey({
    workspaceId: WS,
    name: "reader",
    scopes: ["contacts:read", "campaigns:read", "crm:read", "events:read"],
  }).key;
  noScopeKey = createApiKey({ workspaceId: WS, name: "no-scope", scopes: [] }).key;

  targetId = "t-1";
  db.prepare(
    "INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, ?, ?)",
  ).run(targetId, WS, "Ada Lovelace", "https://linkedin.com/in/ada");

  listId = "l-1";
  db.prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, ?)").run(listId, WS, "My List");
  db.prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(listId, targetId);

  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, ?)").run("wf-1", WS, "WF");
  runId = "r-1";
  db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, status) VALUES (?, ?, ?, ?, ?)").run(
    runId,
    WS,
    "wf-1",
    listId,
    "running",
  );
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(
    "rp-1",
    runId,
    targetId,
  );
  db.prepare(
    "INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, ?, ?)",
  ).run("rpt-1", "rp-1", "email", "in_progress");

  db.prepare(
    "INSERT INTO signal_rules (id, workspace_id, name, signal_type, min_score) VALUES (?, ?, ?, ?, ?)",
  ).run("sr-1", WS, "Hot leads", "product_intent", 50);

  db.prepare(
    "INSERT INTO pipeline_stages (id, workspace_id, name, position) VALUES (?, ?, ?, ?)",
  ).run("ps-1", WS, "Custom Stage", 0);

  db.prepare(
    "INSERT INTO suppressions (id, workspace_id, kind, value) VALUES (?, ?, ?, ?)",
  ).run("sup-1", WS, "email", "do-not-contact@example.com");

  db.prepare(
    "INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("ea-1", "Sender", "sender@example.com", "smtp.example.com", "sender", "secret");
  db.prepare(
    `INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ej-1", WS, "ea-1", "idem-1", "ada@example.com", "Hi", "Body");
  db.prepare(
    `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sm-1", WS, "ej-1", "ea-1", "ada@example.com", "Hi", "msg-1@example.com");
});

function call(
  key: string,
  path: string[],
  query: Record<string, string> = {},
): { status: number; body: unknown } {
  let status = 200;
  let body: unknown;
  const req = {
    headers: { authorization: `Bearer ${key}` },
    method: "GET",
    query: { path, ...query },
    body: {},
  } as unknown as NextApiRequest;
  const res = {
    setHeader: () => {},
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  handler(req, res);
  return { status, body };
}

describe("api/v1 — signal_rules, pipeline_stages, suppressions, sent_messages", () => {
  it("lists each resource scoped to the caller's workspace", () => {
    const rules = call(readKey, ["signal_rules"]) as { status: number; body: { data: unknown[] } };
    expect(rules.status).toBe(200);
    expect(rules.body.data).toHaveLength(1);

    const stages = call(readKey, ["pipeline_stages"]) as { status: number; body: { data: unknown[] } };
    // Six default stages are seeded per workspace on migration, plus the one inserted above.
    expect(stages.body.data.some((s) => (s as { id: string }).id === "ps-1")).toBe(true);

    const supp = call(readKey, ["suppressions"]) as { status: number; body: { data: unknown[] } };
    expect(supp.body.data).toHaveLength(1);

    const sent = call(readKey, ["sent_messages"]) as { status: number; body: { data: unknown[] } };
    expect(sent.body.data).toHaveLength(1);
  });

  it("requires the mapped scope", () => {
    const { status, body } = call(noScopeKey, ["signal_rules"]);
    expect(status).toBe(403);
    expect((body as { required: string }).required).toBe("events:read");
  });

  it("never returns another workspace's rows", () => {
    const otherKey = createApiKey({ workspaceId: OTHER_WS, name: "other", scopes: ["events:read"] }).key;
    const { body } = call(otherKey, ["signal_rules"]) as { body: { data: unknown[] } };
    expect(body.data).toHaveLength(0);
  });
});

describe("api/v1 — run_profiles, run_profile_tracks and list_members", () => {
  it("returns which targets are enrolled in a run", () => {
    const { status, body } = call(readKey, ["run_profiles"], { run_id: runId }) as {
      status: number;
      body: { data: Array<{ target_id: string }> };
    };
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].target_id).toBe(targetId);
  });

  it("returns per-target, per-channel progress via run_profile_tracks", () => {
    const { status, body } = call(readKey, ["run_profile_tracks"], { run_id: runId }) as {
      status: number;
      body: { data: Array<{ target_id: string; track: string; state: string }> };
    };
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].target_id).toBe(targetId);
    expect(body.data[0].track).toBe("email");
    expect(body.data[0].state).toBe("in_progress");
  });

  it("rejects run_profiles for a run in another workspace", () => {
    const otherKey = createApiKey({ workspaceId: OTHER_WS, name: "other2", scopes: ["campaigns:read"] }).key;
    const { status, body } = call(otherKey, ["run_profiles"], { run_id: runId });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("run_not_found");
  });

  it("returns list membership without a run_id/list_id mixup", () => {
    const { status, body } = call(readKey, ["list_members"], { list_id: listId }) as {
      status: number;
      body: { data: Array<{ list_id: string; target_id: string }> };
    };
    expect(status).toBe(200);
    expect(body.data).toEqual([{ list_id: listId, target_id: targetId }]);
  });

  it("requires run_id / list_id query params", () => {
    const runs = call(readKey, ["run_profiles"]);
    expect(runs.status).toBe(400);
    expect((runs.body as { error: string }).error).toBe("run_id_required");

    const lists = call(readKey, ["list_members"]);
    expect(lists.status).toBe(400);
    expect((lists.body as { error: string }).error).toBe("list_id_required");
  });
});
