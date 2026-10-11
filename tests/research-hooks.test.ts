// Researching a contact into a hook line. No provider and no model is ever reached: fetch
// is replaced for the whole file and a call nobody scripted fails the test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-research-hook-tests";

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import { renderOutreachTemplate } from "@/lib/outreach/render";
import handler, { HOOK_BATCH } from "@/pages/api/research/hooks";

type Reply = { status?: number; body?: unknown };
const net = { calls: [] as { url: string; body: Record<string, unknown> | null }[], replies: [] as Reply[] };

vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  if (!/^https:\/\/(api\.firecrawl\.dev|api\.fetch\.tinyfish\.ai|openrouter\.ai)/.test(url)) throw new Error(`A test reached the network: ${url}`);
  net.calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  const reply = net.replies.shift();
  if (!reply) throw new Error(`Something was asked that no test scripted: ${url}`);
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});

const page = (markdown: string) => ({ body: { success: true, data: { markdown, metadata: { title: "T", url: "https://acmewidgets.com/", sourceURL: "https://acmewidgets.com/", statusCode: 200 } } } });
const model = (content: unknown) => ({ body: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0004 } } });

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

let seq = 0;
function workspace(opts: { firecrawl?: boolean; tinyfish?: boolean; ai?: boolean; model?: boolean } = {}) {
  const db = getDb();
  const ws = `ws-hook-${++seq}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Hook ${seq}`, `hook-ws-${seq}`);
  if (opts.firecrawl !== false) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'firecrawl', ?)").run(ws, encryptSecret("fc-test-key"));
  if (opts.tinyfish) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'tinyfish', ?)").run(ws, encryptSecret("tf-test-key"));
  if (opts.ai !== false) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'openrouter', ?)").run(ws, encryptSecret("sk-or-test"));
  if (opts.model !== false) db.prepare("INSERT INTO workspace_ai_config (workspace_id, default_model) VALUES (?, 'anthropic/claude-sonnet-5-5')").run(ws);
  return ws;
}

function contact(ws: string, opts: { website?: string | null; company?: string } = {}) {
  const db = getDb();
  const id = `t-${ws}-${Math.random().toString(36).slice(2, 8)}`;
  let companyId: string | null = null;
  if (opts.website !== null) {
    companyId = `c-${id}`;
    db.prepare("INSERT INTO companies (id, workspace_id, name, website) VALUES (?, ?, ?, ?)").run(companyId, ws, opts.company ?? "Acme", opts.website ?? "https://acmewidgets.com/");
  }
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, company_id, company, linkedin_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, ws, "Dale Cooper", companyId, opts.company ?? "Acme", `https://linkedin.com/in/${id}`);
  return id;
}

const call = async (ws: string, body: unknown, role = "member") => {
  const res = mockRes();
  await handler({ method: "POST", body, query: {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => { net.calls = []; net.replies = []; });

describe("the cost of researching contacts", () => {
  it("says what it would cost without reading a page or asking a model", async () => {
    const ws = workspace();
    const withSite = contact(ws);
    const without = contact(ws, { website: null });

    const res = await call(ws, { dry_run: true, target_ids: [withSite, without] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      selected: 2, eligible: 1, eligible_ids: [withSite], no_website: 1,
      credits: 1, batch: HOOK_BATCH, firecrawl_connected: true, field_key: "hook_line",
    });
    expect(net.calls).toEqual([]);
  });

  it("gives the cost even when nothing is connected, so the screen can show both at once", async () => {
    const ws = workspace({ firecrawl: false, ai: false, model: false });
    const res = await call(ws, { dry_run: true, target_ids: [contact(ws)] });
    expect(res.body).toMatchObject({ eligible: 1, credits: 1, firecrawl_connected: false, tinyfish_connected: false });
    expect(net.calls).toEqual([]);
  });

  it("refuses a viewer, and an empty or oversized selection", async () => {
    const ws = workspace();
    expect((await call(ws, { dry_run: true, target_ids: [contact(ws)] }, "viewer")).statusCode).toBe(403);
    expect((await call(ws, { target_ids: [] })).statusCode).toBe(400);
    expect((await call(ws, { target_ids: Array.from({ length: 501 }, (_, i) => `x${i}`) })).statusCode).toBe(400);
    expect(net.calls).toEqual([]);
  });

  it("takes one batch per request and no more", async () => {
    const ws = workspace();
    const ids = Array.from({ length: HOOK_BATCH + 1 }, () => contact(ws));
    expect((await call(ws, { target_ids: ids })).statusCode).toBe(400);
    expect(net.calls).toEqual([]);
  });
});

describe("writing a hook line", () => {
  it("reads the company's site, writes the line, and makes {{hook_line}} resolve", async () => {
    const ws = workspace();
    const id = contact(ws);
    net.replies.push(page("Acme runs payroll for dental practices in 14 states."));
    net.replies.push(model({ hook: "you run payroll for dental practices in 14 states", grounded_in: "payroll for dental practices" }));

    const res = await call(ws, { target_ids: [id] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ written: 1, no_website: 0, unreadable: 0, no_hook: 0 });

    const db = getDb();
    const custom = loadTargetCustomValues(db, ws, id);
    expect(custom.hook_line).toBe("you run payroll for dental practices in 14 states");

    // The point of using a custom field: the renderer already resolves it, unchanged.
    const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(id) as Parameters<typeof renderOutreachTemplate>[1];
    expect(renderOutreachTemplate("Saw {{hook_line}}.", target, custom)).toBe("Saw you run payroll for dental practices in 14 states.");
  });

  it("writes nothing when the page says nothing specific", async () => {
    // A generic opener is worse than none: it reads as automated to the one person it was
    // meant to land with. The model may decline, and declining is not a failure.
    const ws = workspace();
    const id = contact(ws);
    net.replies.push(page("Welcome to our website. We are passionate about solutions."));
    net.replies.push(model({ hook: null, grounded_in: null }));

    const res = await call(ws, { target_ids: [id] });
    expect(res.body).toMatchObject({ written: 0, no_hook: 1 });
    expect(loadTargetCustomValues(getDb(), ws, id).hook_line).toBe("");
  });

  it("records the spend against the workspace's AI budget", async () => {
    const ws = workspace();
    const id = contact(ws);
    net.replies.push(page("Acme sells widgets to dentists."));
    net.replies.push(model({ hook: "you sell widgets to dentists", grounded_in: "widgets to dentists" }));
    await call(ws, { target_ids: [id] });

    const row = getDb().prepare("SELECT purpose, target_id, cost_usd FROM agent_sessions WHERE workspace_id = ?").get(ws) as { purpose: string; target_id: string; cost_usd: number };
    expect(row).toMatchObject({ purpose: "research", target_id: id });
    expect(row.cost_usd).toBeGreaterThan(0);
  });

  it("counts a contact with no website without spending on it", async () => {
    const ws = workspace();
    const res = await call(ws, { target_ids: [contact(ws, { website: null })] });
    expect(res.body).toMatchObject({ written: 0, no_website: 1 });
    expect(net.calls).toEqual([]);
  });

  it("stops the run when the provider refuses, and reports what was done", async () => {
    const ws = workspace();
    const first = contact(ws);
    const second = contact(ws);
    net.replies.push(page("Acme sells widgets."));
    net.replies.push(model({ hook: "you sell widgets", grounded_in: "widgets" }));
    net.replies.push({ status: 401, body: { success: false, error: "bad key" } });

    const res = await call(ws, { target_ids: [first, second] });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ written: 1 });
    expect(String(res.body.error)).toContain("API key was not accepted");
  });

  it("falls back to TinyFish's free reader when Firecrawl is out of credits", async () => {
    // Firecrawl running dry mid-run would otherwise leave the rest of the selection
    // unresearched, while TinyFish reads pages for nothing.
    const ws = workspace({ tinyfish: true });
    const id = contact(ws);
    net.replies.push({ status: 402, body: { success: false, error: "Insufficient credits" } });
    net.replies.push({ body: { results: [{ url: "https://acmewidgets.com/", final_url: "https://acmewidgets.com/", title: "Acme", text: "Acme sells widgets to dentists." }] } });
    net.replies.push(model({ hook: "you sell widgets to dentists", grounded_in: "widgets" }));

    const res = await call(ws, { target_ids: [id] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ written: 1 });
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://api.firecrawl.dev/v2/scrape",
      "https://api.fetch.tinyfish.ai/",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("says what to connect rather than failing, when research is not set up", async () => {
    for (const [opts, expected] of [
      [{ firecrawl: false }, "Connect Firecrawl"],
      [{ ai: false }, "OpenRouter or Google Gemini API key"],
      [{ model: false }, "default model"],
    ] as const) {
      const ws = workspace(opts);
      const res = await call(ws, { target_ids: [contact(ws)] });
      expect(res.statusCode, JSON.stringify(opts)).toBe(400);
      expect(String(res.body.error)).toContain(expected);
    }
    expect(net.calls).toEqual([]);
  });
});
