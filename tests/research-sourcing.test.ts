// Finding companies from a page that lists them, and which provider each page calls for.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-sourcing-tests";
// Hand the run back after one poll instead of waiting out the real 20-second window.
process.env.RESEARCH_AGENT_WAIT_MS = "0";

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";
import { MAX_SOURCED, keepSourced, planSourcing, readSourced } from "@/lib/research/sourcing";
import handler from "@/pages/api/research/sourcing";

describe("planSourcing", () => {
  it("reads a static listing page with Firecrawl, in one request", () => {
    const plan = planSourcing("https://fund.example.com/portfolio");
    expect(plan).toMatchObject({ provider: "firecrawl", credits: 5, max_usd: null });
  });

  it("sends a page that needs a search to the agent instead", () => {
    // There is no address to read until something has been typed, so a reader cannot get
    // there however many credits it spends.
    const plan = planSourcing("https://directory.example.com/search?q=dental");
    expect(plan).toMatchObject({ provider: "tinyfish", credits: 0 });
    expect(plan!.max_usd).toBeGreaterThan(0);
    expect(plan!.reason).toContain("agent");
  });

  it("refuses an address nothing could be read from", () => {
    for (const url of ["", "not a url", "http://localhost:3000/list", "ftp://x.example.com"]) {
      expect(planSourcing(url), url).toBeNull();
    }
  });
});

describe("readSourced", () => {
  it("drops a company with no name, which is the one field nothing can fill in later", () => {
    const found = readSourced({ companies: [{ name: "Acme", website: "https://acme-one.com" }, { name: "  ", website: "https://x.com" }, { website: "https://y.com" }] });
    expect(found.map((c) => c.name)).toEqual(["Acme"]);
  });

  it("deduplicates on domain, because a portfolio page links the same company twice", () => {
    const found = readSourced({ companies: [
      { name: "Acme", website: "https://acme-one.com/" },
      { name: "Acme Inc", website: "https://acme-one.com/about" },
    ] });
    expect(found).toHaveLength(1);
    expect(found[0].domain).toBe("acme-one.com");
  });

  it("keeps a company with no website, matched on its name instead", () => {
    const found = readSourced({ companies: [{ name: "Acme", website: null }] });
    expect(found[0]).toMatchObject({ name: "Acme", website: null, domain: null });
  });

  it("stops at the cap, so one page cannot flood the workspace", () => {
    const found = readSourced({ companies: Array.from({ length: MAX_SOURCED + 20 }, (_, i) => ({ name: `Co ${i}`, website: `https://co${i}-example.com` })) });
    expect(found).toHaveLength(MAX_SOURCED);
  });

  it("survives a provider that returned nothing useful", () => {
    expect(readSourced(null)).toEqual([]);
    expect(readSourced({ companies: "not an array" })).toEqual([]);
  });
});

describe("keepSourced", () => {
  it("adds what is new and counts what the workspace already had", () => {
    const db = getDb();
    const ws = "ws-src-keep";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, "Src", "src-keep-ws");
    db.prepare("INSERT INTO companies (id, workspace_id, name, domain) VALUES ('known-1', ?, 'Known', 'known-example.com')").run(ws);

    const result = keepSourced(db, ws, [
      { name: "Known Renamed", website: "https://known-example.com/", domain: "known-example.com", description: null },
      { name: "Fresh", website: "https://fresh-example.com/", domain: "fresh-example.com", description: "Does things" },
    ]);
    expect(result).toEqual({ added: 1, already_known: 1 });

    // The existing company keeps its own name: sourcing adds companies, it does not rename them.
    expect((db.prepare("SELECT name FROM companies WHERE id = 'known-1'").get() as { name: string }).name).toBe("Known");
    expect(db.prepare("SELECT name, description FROM companies WHERE workspace_id = ? AND domain = 'fresh-example.com'").get(ws)).toMatchObject({ name: "Fresh", description: "Does things" });
  });

  it("adds nothing the second time the same page is read", () => {
    const db = getDb();
    const ws = "ws-src-twice";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, "Twice", "src-twice-ws");
    const found = [{ name: "Acme", website: "https://acme-twice.com/", domain: "acme-twice.com", description: null }];
    expect(keepSourced(db, ws, found)).toEqual({ added: 1, already_known: 0 });
    expect(keepSourced(db, ws, found)).toEqual({ added: 0, already_known: 1 });
  });
});

// ── the route ────────────────────────────────────────────────────────────────────────────

type Reply = { status?: number; body?: unknown };
const net = { calls: [] as string[], replies: [] as Reply[] };
vi.stubGlobal("fetch", async (input: unknown) => {
  const url = String(input);
  if (!/^https:\/\/(api\.firecrawl\.dev|agent\.tinyfish\.ai)/.test(url)) throw new Error(`A test reached the network: ${url}`);
  net.calls.push(url);
  const reply = net.replies.shift();
  if (!reply) throw new Error(`A provider was asked something no test scripted: ${url}`);
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});
const extracted = (json: unknown) => ({ body: { success: true, data: { json, metadata: { statusCode: 200 } } } });

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

let seq = 0;
function workspace(opts: { firecrawl?: boolean; tinyfish?: boolean } = {}) {
  const db = getDb();
  const ws = `ws-srcroute-${++seq}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Src ${seq}`, `srcroute-ws-${seq}`);
  if (opts.firecrawl !== false) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'firecrawl', ?)").run(ws, encryptSecret("fc-test-key"));
  if (opts.tinyfish) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'tinyfish', ?)").run(ws, encryptSecret("tf-test-key"));
  return ws;
}
const call = async (ws: string, body: unknown, role = "member") => {
  const res = mockRes();
  await handler({ method: "POST", body, query: {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => { net.calls = []; net.replies = []; });

describe("the sourcing route", () => {
  it("says which provider a page calls for without reading it", async () => {
    const ws = workspace({ tinyfish: true });
    const statik = await call(ws, { dry_run: true, url: "https://fund.example.com/portfolio" });
    expect(statik.body).toMatchObject({ provider: "firecrawl", credits: 5, ready: true });

    const interactive = await call(ws, { dry_run: true, url: "https://dir.example.com/search?q=x" });
    expect(interactive.body).toMatchObject({ provider: "tinyfish", ready: true });
    expect(net.calls).toEqual([]);
  });

  it("reads a static page and keeps the companies it did not have", async () => {
    const ws = workspace();
    net.replies.push(extracted({ companies: [{ name: "Acme", website: "https://acme-route.com" }, { name: "Beta", website: null }] }));
    const res = await call(ws, { url: "https://fund.example.com/portfolio" });
    expect(res.body).toMatchObject({ done: true, provider: "firecrawl", found: 2, added: 2, already_known: 0 });
    expect(net.calls).toEqual(["https://api.firecrawl.dev/v2/scrape"]);
  });

  it("hands back a run to poll rather than holding the request open for an agent", async () => {
    // An agent run takes tens of seconds. Holding on is how a gateway times out and the
    // steps get paid for with nothing to show, so the run id goes back instead.
    const ws = workspace({ tinyfish: true });
    net.replies.push({ body: { run_id: "run-src-1" } });
    net.replies.push({ body: { status: "RUNNING", result: null, num_of_steps: 2 } });
    const res = await call(ws, { url: "https://dir.example.com/search?q=dental" });
    expect(res.body).toMatchObject({ done: false, provider: "tinyfish", run_id: "run-src-1", status: "running" });
  });

  it("keeps what the agent found when its run is resumed", async () => {
    const ws = workspace({ tinyfish: true });
    net.replies.push({ body: { status: "COMPLETED", result: { companies: [{ name: "Gamma", website: "https://gamma-route.com" }] }, num_of_steps: 6 } });
    const res = await call(ws, { run_id: "run-src-1" });
    expect(res.body).toMatchObject({ done: true, found: 1, added: 1 });
    expect(res.body.cost_usd).toBeCloseTo(0.096, 3);
  });

  it("says what to connect, naming the reason the agent is the one needed", async () => {
    const ws = workspace({ firecrawl: false });
    const res = await call(ws, { url: "https://dir.example.com/search?q=x" });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain("search or a sign-in");
    expect(net.calls).toEqual([]);
  });

  it("refuses a viewer and an address nothing could be read from", async () => {
    const ws = workspace();
    expect((await call(ws, { dry_run: true, url: "https://fund.example.com/portfolio" }, "viewer")).statusCode).toBe(403);
    expect((await call(ws, { url: "not a url" })).statusCode).toBe(400);
    expect(net.calls).toEqual([]);
  });
});
