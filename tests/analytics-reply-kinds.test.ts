// Campaign analytics counted replies by labels an earlier classifier used. The current one
// writes different labels, so "replied" and "auto-replied" were always zero. Both sets still
// exist on real contacts; this pins the counts to all of them.
import { beforeAll, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import analytics from "@/pages/api/workflows/[id]/analytics";
import { ctxHeaders } from "./helpers/ctx";

const WS = "ws-replykinds-1";
const WORKFLOW = "wf-replykinds-1";
const RUN = "run-replykinds-1";

function audience(): Record<string, number> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  analytics({ method: "GET", query: { id: WORKFLOW }, headers: ctxHeaders(WS) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(200);
  return (res.body as { audience: Record<string, number> }).audience;
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, WS, WS);
  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, 'Campaign')").run(WORKFLOW, WS);
  db.prepare("INSERT INTO runs (id, workflow_id, workspace_id, status) VALUES (?, ?, ?, 'running')").run(RUN, WORKFLOW, WS);
  const kinds = [
    "positive", "negative", "unsubscribe", "human_review", // a person answered (current labels)
    "human_reply", "not_interested",                       // a person answered (older labels)
    "out_of_office",                                       // a mailbox answered (current)
    "ooo_followup", "substitute", "call_task",             // a mailbox answered (older)
    null,                                                  // no reply at all
  ];
  kinds.forEach((kind, i) => {
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url, reply_kind) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`rk-target-${i}`, WS, `Lead ${i}`, `lead${i}@example.com`, `https://www.linkedin.com/in/rk-lead-${i}/`, kind);
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rk-rp-${i}`, RUN, `rk-target-${i}`);
  });
});

describe("campaign analytics audience", () => {
  it("counts every contact a person answered for, under old and new labels", () => {
    expect(audience().replied).toBe(6);
  });

  it("counts automatic answers apart from those", () => {
    expect(audience().auto_replied).toBe(4);
  });

  it("leaves a contact with no reply out of both", () => {
    const a = audience();
    expect(a.enrolled).toBe(11);
    expect(a.replied + a.auto_replied).toBe(10);
  });
});
