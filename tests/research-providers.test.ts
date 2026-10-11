// The two research clients. Neither provider is ever reached: fetch is replaced for the
// whole file, every call is recorded, and a call nobody scripted fails the test — so a
// client that quietly changes its request shape cannot pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-research-provider-tests";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ResearchRefused, needsInteraction, researchConnected, researchKey } from "@/lib/research/providers";
import { crawlState, extractPage, readPage, readableUrl, remainingCredits, startCrawl } from "@/lib/research/firecrawl";
import { MAX_STEPS, agentRunState, fetchPages, startAgentRun } from "@/lib/research/tinyfish";

type Reply = { status?: number; body?: unknown; throws?: true };
const net = { calls: [] as { url: string; method: string; key: string | null; body: Record<string, unknown> | null }[], replies: [] as Reply[] };

vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const url = String(input);
  if (!/^https:\/\/(api\.firecrawl\.dev|agent\.tinyfish\.ai|api\.fetch\.tinyfish\.ai)/.test(url)) {
    throw new Error(`A test reached the network: ${url}`);
  }
  net.calls.push({
    url,
    method: init?.method ?? "GET",
    key: init?.headers?.["Authorization"] ?? init?.headers?.["X-API-Key"] ?? null,
    body: init?.body ? JSON.parse(init.body) : null,
  });
  const reply = net.replies.shift();
  if (!reply) throw new Error(`A provider was asked something no test scripted: ${url}`);
  if (reply.throws) throw new Error("socket hang up");
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});

beforeEach(() => { net.calls = []; net.replies = []; });

describe("readableUrl", () => {
  it("accepts a real site and adds the scheme a user left off", () => {
    expect(readableUrl("example.com")).toBe("https://example.com/");
    expect(readableUrl("https://example.com/careers")).toBe("https://example.com/careers");
  });

  it("refuses an address a reader could not usefully be pointed at", () => {
    // The scraper runs on the provider's machines, so these are not a way into this network
    // — they are a credit spent on nothing, so they never leave.
    for (const value of ["localhost", "http://127.0.0.1:3000", "app.local", "nothing", "", null, "ftp://files.example.com"]) {
      expect(readableUrl(value), String(value)).toBeNull();
    }
  });
});

describe("needsInteraction", () => {
  it("is true only where the content does not exist until something is done", () => {
    expect(needsInteraction("https://boards.example.com/search?q=engineer")).toBe(true);
    expect(needsInteraction("https://example.com/login")).toBe(true);
    expect(needsInteraction("https://example.com/jobs/search")).toBe(true);
  });

  it("is false for an ordinary page, however messy", () => {
    // The escalation must not trigger on "hard to parse": paying an agent to re-read a
    // static page buys latency and steps, not content.
    expect(needsInteraction("https://example.com/careers")).toBe(false);
    expect(needsInteraction("https://example.com/about-us/team")).toBe(false);
    expect(needsInteraction("not a url")).toBe(false);
  });
});

describe("Firecrawl", () => {
  it("asks for markdown as an object format and reads the answer from data.markdown", async () => {
    net.replies.push({ body: { success: true, data: { markdown: "# Acme\n\nWe sell widgets.", metadata: { title: "Acme", url: "https://acme.test/", sourceURL: "https://acme.test/", statusCode: 200 } } } });
    const page = await readPage("https://acme.test/", "fc-test-key");

    expect(page).toEqual({ url: "https://acme.test/", final_url: "https://acme.test/", title: "Acme", markdown: "# Acme\n\nWe sell widgets." });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(net.calls[0].key).toBe("Bearer fc-test-key");
    // Objects, not bare strings: only the object form is in the spec and works for every format.
    expect(net.calls[0].body).toMatchObject({ url: "https://acme.test/", formats: [{ type: "markdown" }], onlyMainContent: true });
  });

  it("returns null for a page it reached but found nothing on", async () => {
    net.replies.push({ body: { success: true, data: { markdown: "   ", metadata: { statusCode: 200 } } } });
    expect(await readPage("https://empty.test/", "fc-test-key")).toBeNull();
  });

  it("sends the schema and reads the extracted object from data.json", async () => {
    net.replies.push({ body: { success: true, data: { json: { mission: "widgets" }, metadata: { statusCode: 200 } } } });
    const schema = { type: "object", properties: { mission: { type: "string" } } };
    expect(await extractPage("https://acme.test/", "fc-test-key", schema)).toEqual({ mission: "widgets" });
    expect(net.calls[0].body).toMatchObject({ formats: [{ type: "json", schema }] });
  });

  it("tells a refusal that stops a run from one that is worth retrying", async () => {
    const cases: Array<[number, boolean]> = [[401, false], [402, false], [403, false], [408, true], [429, true], [503, true]];
    for (const [status, retryable] of cases) {
      net.replies.push({ status, body: { success: false, error: "nope" } });
      await expect(readPage("https://acme.test/", "fc-test-key"), String(status)).rejects.toMatchObject({ name: "ResearchRefused", status, retryable });
    }
  });

  it("reports no answer at all as status 0, so callers have one shape to branch on", async () => {
    net.replies.push({ throws: true });
    await expect(readPage("https://acme.test/", "fc-test-key")).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it("always sends a page limit, because Firecrawl's own default is ten thousand", async () => {
    net.replies.push({ body: { success: true, id: "crawl-1", url: "https://api.firecrawl.dev/v2/crawl/crawl-1" } });
    expect(await startCrawl("https://acme.test/careers", "fc-test-key", { limit: 20, include: ["^/careers"] })).toEqual({ id: "crawl-1" });
    expect(net.calls[0].body).toMatchObject({ limit: 20, includePaths: ["^/careers"] });
  });

  it("does not treat a present `next` as proof a crawl has finished", async () => {
    // `next` is present on unfinished crawls too, so stopping on it would truncate results.
    net.replies.push({ body: { status: "scraping", completed: 3, total: 10, creditsUsed: 3, next: "https://api.firecrawl.dev/v2/crawl/crawl-1?skip=3", data: [{ markdown: "Jobs", metadata: { sourceURL: "https://acme.test/careers", url: "https://acme.test/careers", title: "Careers" } }] } });
    const state = await crawlState("crawl-1", "fc-test-key");
    expect(state.status).toBe("scraping");
    expect(state.next).not.toBeNull();
    expect(state.pages).toEqual([{ url: "https://acme.test/careers", final_url: "https://acme.test/careers", title: "Careers", markdown: "Jobs" }]);
  });

  it("reads the credits left, for a preview that can warn before the provider refuses", async () => {
    net.replies.push({ body: { success: true, data: { remainingCredits: 412 } } });
    expect(await remainingCredits("fc-test-key")).toBe(412);
  });
});

describe("TinyFish", () => {
  it("reads pages through the free tier and reports per-URL failures without failing the batch", async () => {
    // Per-URL errors arrive with the request still a 200, so partial success is the normal
    // case: what worked is returned and the rest reported, never silently dropped.
    net.replies.push({ body: { results: [{ url: "https://a.test/", final_url: "https://a.test/", title: "A", text: "Page A" }], errors: [{ url: "https://b.test/", code: "bot_blocked", message: "blocked" }] } });
    const result = await fetchPages(["https://a.test/", "https://b.test/"], "tf-test-key");

    expect(result.pages).toEqual([{ url: "https://a.test/", final_url: "https://a.test/", title: "A", markdown: "Page A" }]);
    expect(result.failed).toEqual([{ url: "https://b.test/", reason: "blocked" }]);
    expect(net.calls[0].key).toBe("tf-test-key");
  });

  it("refuses more than ten addresses without asking", async () => {
    await expect(fetchPages(Array.from({ length: 11 }, (_, i) => `https://x${i}.test/`), "tf-test-key")).rejects.toBeInstanceOf(ResearchRefused);
    expect(net.calls).toEqual([]);
  });

  it("caps the steps of every run it starts, because steps are money", async () => {
    net.replies.push({ body: { run_id: "run-1" } });
    await startAgentRun({ url: "https://acme.test/jobs/search", goal: "Find open engineering roles", schema: { type: "object", properties: { roles: { type: "array" } } } }, "tf-test-key");

    expect(net.calls[0].url).toBe("https://agent.tinyfish.ai/v1/automation/run-async");
    expect(net.calls[0].body).toMatchObject({ agent_config: { max_steps: MAX_STEPS } });
    expect(MAX_STEPS).toBeLessThan(150); // TinyFish's own default, which would cost $2.40 a run
  });

  it("does not take COMPLETED as proof the goal was met", async () => {
    // TinyFish says plainly that COMPLETED means the infrastructure worked. An empty result
    // on a completed run is "nothing found", not success.
    net.replies.push({ body: { status: "COMPLETED", result: null, num_of_steps: 4 } });
    const state = await agentRunState("run-1", "tf-test-key");
    expect(state.status).toBe("completed");
    expect(state.result).toBeNull();
    expect(state.cost_usd).toBeCloseTo(0.064, 4);
  });

  it("finds the answer whether it sits at result or nested at result.result", async () => {
    net.replies.push({ body: { status: "COMPLETED", result: { roles: ["SRE"] }, num_of_steps: 3 } });
    expect((await agentRunState("run-1", "tf-test-key")).result).toEqual({ roles: ["SRE"] });

    net.replies.push({ body: { status: "COMPLETED", result: { result: ["SRE", "Platform"] }, num_of_steps: 3 } });
    expect((await agentRunState("run-2", "tf-test-key")).result).toEqual(["SRE", "Platform"]);
  });

  it("reads a run-level failure out of a 200 body and only retries the provider's own fault", async () => {
    net.replies.push({ body: { status: "FAILED", result: null, num_of_steps: 2, error: { code: "service_busy", message: "Browser crashed", category: "SYSTEM_FAILURE" } } });
    expect(await agentRunState("run-1", "tf-test-key")).toMatchObject({ status: "failed", error: "Browser crashed", retryable: true });

    net.replies.push({ body: { status: "FAILED", result: null, num_of_steps: 1, error: { code: "task_failed", message: "Could not find it", category: "AGENT_FAILURE" } } });
    expect(await agentRunState("run-2", "tf-test-key")).toMatchObject({ status: "failed", retryable: false });
  });

  it("reads an empty wallet the same way whether it answers 402 or 403", async () => {
    for (const status of [402, 403]) {
      net.replies.push({ status, body: { error: { code: "INSUFFICIENT_CREDITS", message: "no credits" } } });
      await expect(agentRunState("run-1", "tf-test-key"), String(status)).rejects.toMatchObject({ message: expect.stringContaining("wallet is empty"), retryable: false });
    }
  });
});

describe("keys", () => {
  it("reads each provider's key from the workspace, decrypted, and says which are connected", () => {
    const db = getDb();
    const ws = "ws-research-keys-0001";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, "Research WS", "research-keys-ws");
    db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'firecrawl', ?)").run(ws, encryptSecret("fc-stored"));

    expect(researchKey(db, ws, "firecrawl")).toBe("fc-stored");
    expect(researchKey(db, ws, "tinyfish")).toBeNull();
    expect(researchConnected(db, ws)).toEqual({ firecrawl: true, tinyfish: false });
  });
});
