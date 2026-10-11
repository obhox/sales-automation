// AI & models: the settings and their routes, the writer's prompt, the fallback model, the
// monthly budget and what it does to a running campaign, and what requests cost.
// Real (throwaway) database. OpenRouter is a stub throughout: no request leaves the process.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string, options: { messageId: string }) => { smtp.sent.push({ to, subject, body }); return { messageId: options.messageId }; },
}));
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { buildPrompt, communityAi, generateCommunityContent, type CommunityAiParams } from "@/lib/community-ai";
import { classifyAndDispatch } from "@/lib/community-replies";
import { EARLIER_EXAMPLES_TITLE, TONE_INSTRUCTION, examplesForPrompt, parseExamples, readAiConfig, saveAiConfig } from "@/lib/ai/config";
import { OpenRouterError, modelsFromListing, openrouterUrl, worthTryingAnotherModel } from "@/lib/ai/openrouter";
import { aiSteps } from "@/lib/ai/steps";
import { AiBudgetReachedError, assertWithinBudget, budgetState, recordAiUsage, usageOverview } from "@/lib/ai/usage";
import { aiAttention } from "@/lib/ai/attention";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { listNotifications } from "@/lib/platform/notifications";
import configHandler from "@/pages/api/platform/ai-config";
import overviewHandler, { keyHint, type AiOverview } from "@/pages/api/ai/overview";
import stepsHandler from "@/pages/api/ai/steps";
import testHandler from "@/pages/api/ai/test";
import modelsHandler from "@/pages/api/openrouter/models";
import previewHandler from "@/pages/api/agent/preview";
import runsHandler from "@/pages/api/runs";

const db = () => getDb();
let seq = 0;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterAll(() => vi.unstubAllGlobals());

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
/** What OpenRouter sends back for a finished request. */
const written = (content: Record<string, unknown>, usage: Record<string, unknown> = { prompt_tokens: 900, completion_tokens: 120, cost: 0.004 }) =>
  json({ choices: [{ message: { content: JSON.stringify(content) } }], usage });
const refused = (status: number, message = "refused") => json({ error: { message } }, status);
const requestedModels = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).model as string);

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

/** A workspace, and a way to call a route as any of its members. */
function workspace(opts: { key?: boolean } = {}) {
  const n = ++seq;
  const ws = `ws-ai-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  if (opts.key !== false) db().prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'openrouter', ?)").run(ws, encryptSecret(`sk-or-v1-test-key-${n}-9f3c`));
  const call = async (
    handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
    method: string,
    request: { body?: unknown; query?: Record<string, string>; role?: string } = {},
  ) => {
    const res = mockRes();
    const role = request.role ?? "admin";
    await handler({ method, body: request.body ?? {}, query: request.query ?? {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const contact = (fields: { name?: string; email?: string } = {}) => {
    const id = `ai-target-${++seq}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, first_name, company, title, email, email_status, email_verified_at, linkedin_url) VALUES (?, ?, ?, 'Lee', 'Northwind', 'VP Sales', ?, 'verified', datetime('now'), ?)")
      .run(id, ws, fields.name ?? "Lee Lead", fields.email ?? `lead${seq}@prospect.test`, `https://www.linkedin.com/in/ai-lead-${seq}/`);
    return id;
  };
  /** Requests already paid for: `cost` dollars, `daysAgo` days back. */
  const spent = (cost: number, daysAgo = 0, fields: Record<string, unknown> = {}) => {
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const row: Record<string, unknown> = { id: `ai-session-${++seq}`, workspace_id: ws, model: "test/primary", input_tokens: 100, output_tokens: 20, cost_usd: cost, created_at: at, ...fields };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO agent_sessions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
  };
  const config = (fields: Record<string, unknown>) => {
    const saved = saveAiConfig(ws, fields);
    if (!saved.ok) throw new Error(saved.error);
  };
  const sessions = () => db().prepare("SELECT model, purpose, used_fallback, cost_usd, run_id, target_id, step_id, input_tokens, output_tokens FROM agent_sessions WHERE workspace_id = ? ORDER BY rowid").all(ws) as Array<Record<string, unknown>>;
  return { ws, call, contact, spent, config, sessions };
}

const notes = (ws: string) => listNotifications(ws, "nobody", "owner").filter((note) => note.kind === "ai.budget_reached");
const events = (ws: string) => db().prepare("SELECT type, payload_json FROM domain_events WHERE workspace_id = ? AND type = 'ai.budget_reached'").all(ws) as Array<{ type: string; payload_json: string }>;

/** A request to the writer for one of a workspace's contacts. */
function request(w: ReturnType<typeof workspace>, fields: Partial<CommunityAiParams> = {}): CommunityAiParams {
  const targetId = fields.targetId ?? w.contact();
  const data = communityAi.getContactWithCompany(targetId)!;
  return { apiKey: "sk-or-v1-test", model: "test/primary", stepType: "email", contact: data.contact, company: data.company, agentConfig: communityAi.getAgentConfig(w.ws), targetId, ...fields };
}

beforeEach(() => {
  fetchMock.mockReset();
  smtp.sent.length = 0;
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending')").run();
});

// ─────────────────────────────────────────────────────────────────────
describe("the writer's prompt", () => {
  // The prompt as it was built before tone, titled examples and the fallback existed.
  function promptAsItWas(params: CommunityAiParams): string {
    const outputShape = params.stepType === "message" ? '{"body":"personalized LinkedIn message"}' : '{"subject":"concise subject","body":"personalized message body"}';
    const compact = (value: Record<string, unknown> | null | undefined) => (value ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== "" && field !== undefined)) : null);
    return JSON.stringify({
      task: params.stepType,
      instructions: [
        "Write concise, natural B2B outreach that sounds like a thoughtful human.",
        "Use only facts supplied in the contact and company context; never invent achievements, events, or relationships.",
        "Avoid hype, generic compliments, fake familiarity, and unsupported claims.",
        `Write in ${params.language || "English"}.`,
        params.maxWords ? `Keep the body at or below ${params.maxWords} words.` : "Keep the body brief.",
        `Return only valid JSON matching ${outputShape}.`,
      ],
      campaign_context: params.campaignPrompt || null,
      step_instruction: params.stepPrompt || null,
      global_system_prompt: params.agentConfig?.system_prompt || null,
      global_user_prompt: params.agentConfig?.user_prompt || null,
      contact: compact(params.contact),
      company: compact(params.company),
      previous_linkedin_message: params.previousMessageContext || null,
      previous_email: params.followupContext || null,
      reply_context: params.replyContext || null,
      examples: { email: params.agentConfig?.email_examples || null, linkedin: params.agentConfig?.linkedin_examples || null },
    }, null, 2);
  }

  it("is word for word what it was for a workspace with no settings at all", () => {
    const w = workspace();
    for (const stepType of ["email", "message", "sales_inmail"] as const) {
      const params = request(w, { stepType, stepPrompt: "Lead with the funding round", maxWords: 80, language: "German", campaignPrompt: "We sell to revenue teams." });
      expect(buildPrompt(params)).toBe(promptAsItWas(params));
    }
  });

  it("is word for word what it was for settings saved before this screen: prompts and examples as plain text, no tone", () => {
    const w = workspace();
    db().prepare("INSERT INTO workspace_ai_config (workspace_id, default_model, system_prompt, user_prompt, email_examples, linkedin_examples) VALUES (?, 'test/primary', 'Be brief.', 'No emoji.', 'Subject: Hi\n\nA good email.', 'A good note.')").run(w.ws);
    const params = request(w, { followupContext: { followupNumber: 1, previousSubject: "Hi", previousBody: "Earlier." }, replyContext: "Out until Monday." });
    // The row now carries the new columns, all empty.
    expect(params.agentConfig).toMatchObject({ tone: null, fallback_model: null, monthly_budget_usd: null });
    expect(buildPrompt(params)).toBe(promptAsItWas(params));
  });

  it("gains one instruction when a tone is chosen, and nothing else changes", () => {
    const w = workspace();
    w.config({ tone: "warm" });
    const params = request(w);
    const plain = JSON.parse(promptAsItWas(params)) as { instructions: string[] };
    const toned = JSON.parse(buildPrompt(params)) as { instructions: string[] };
    expect(toned.instructions).toEqual([...plain.instructions.slice(0, -1), TONE_INSTRUCTION.warm, plain.instructions.at(-1)]);
    expect({ ...toned, instructions: null }).toEqual({ ...plain, instructions: null });
  });

  it("shows the writer titled examples as numbered text", () => {
    const w = workspace();
    w.config({ email_examples: [{ title: "Series B congrats", body: "Saw the round. Worth a call?" }, { title: "", body: "Second one." }] });
    const prompt = JSON.parse(buildPrompt(request(w))) as { examples: { email: string | null; linkedin: string | null } };
    expect(prompt.examples.email).toBe("Example 1: Series B congrats\nSaw the round. Worth a call?\n\nExample 2\nSecond one.");
    expect(prompt.examples.linkedin).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("examples", () => {
  it("read text saved before examples had titles as one example, and pass it to the writer untouched", () => {
    const text = "Subject: Hi\n\nA good email.\n\n---\n\nAnother.";
    expect(parseExamples(text)).toEqual([{ title: EARLIER_EXAMPLES_TITLE, body: text }]);
    expect(examplesForPrompt(text)).toBe(text);
  });

  it("read nothing as nothing", () => {
    for (const empty of [null, undefined, "", "   "]) expect(parseExamples(empty)).toEqual([]);
    expect(examplesForPrompt(null)).toBeNull();
    expect(examplesForPrompt("")).toBeNull();
    expect(examplesForPrompt("[]")).toBeNull();
  });

  it("treat text that only looks like a list as text", () => {
    for (const text of ["[brackets] at the start of an email", '["a","b"]', '[{"title":"no body"}]']) {
      expect(parseExamples(text)).toEqual([{ title: EARLIER_EXAMPLES_TITLE, body: text }]);
      expect(examplesForPrompt(text)).toBe(text);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("saving the settings", () => {
  it("changes what it is sent and leaves the rest as it was", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", system_prompt: "Be brief.", user_prompt: "No emoji.", email_examples: "An email.", monthly_budget_usd: 100, tone: "direct", fallback_model: "test/backup" });

    const res = await w.call(configHandler, "PUT", { body: { default_model: "test/other" } });

    expect(res.statusCode).toBe(200);
    expect(readAiConfig(w.ws)).toMatchObject({
      default_model: "test/other", fallback_model: "test/backup", tone: "direct", system_prompt: "Be brief.", user_prompt: "No emoji.",
      email_examples: [{ title: EARLIER_EXAMPLES_TITLE, body: "An email." }], linkedin_examples: [], monthly_budget_usd: 100,
    });
  });

  it("clears a setting sent as null or empty", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", fallback_model: "test/backup", tone: "formal", system_prompt: "Be brief.", monthly_budget_usd: 50, linkedin_examples: [{ title: "Note", body: "Hello." }] });

    await w.call(configHandler, "PUT", { body: { fallback_model: null, tone: "neutral", system_prompt: "", monthly_budget_usd: null, linkedin_examples: [] } });

    expect(readAiConfig(w.ws)).toMatchObject({ default_model: "test/primary", fallback_model: null, tone: null, system_prompt: "", monthly_budget_usd: null, linkedin_examples: [] });
  });

  it("keeps examples as a list with titles, and still takes plain text", async () => {
    const w = workspace();
    await w.call(configHandler, "PUT", { body: { email_examples: [{ title: "  Opener  ", body: "  Hello there.  " }], linkedin_examples: "Plain text from an older caller." } });
    expect(readAiConfig(w.ws).email_examples).toEqual([{ title: "Opener", body: "Hello there." }]);
    expect(readAiConfig(w.ws).linkedin_examples).toEqual([{ title: EARLIER_EXAMPLES_TITLE, body: "Plain text from an older caller." }]);
    // The stored row is what the MCP tool and the old screen read.
    const row = (await w.call(configHandler, "GET")).body;
    expect(row.linkedin_examples).toBe("Plain text from an older caller.");
    expect(JSON.parse(String(row.email_examples))).toEqual([{ title: "Opener", body: "Hello there." }]);
  });

  it("says what is wrong with a setting and saves none of the request", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ tone: "shouty" }, /tone must be one of direct, warm, formal/],
      [{ monthly_budget_usd: 0 }, /above zero/],
      [{ monthly_budget_usd: -5 }, /above zero/],
      [{ monthly_budget_usd: "100" }, /above zero/],
      [{ monthly_budget_usd: 1_000_000 }, /at most \$100,000/],
      [{ default_model: "two words" }, /default model must be a model id/],
      [{ fallback_model: 42 }, /fallback model must be a model id/],
      [{ system_prompt: "x".repeat(2001) }, /writing style can be at most 2,000 characters/],
      [{ email_examples: [{ title: "No text", body: "  " }] }, /Example emails, example 1 has no text/],
      [{ linkedin_examples: Array.from({ length: 13 }, () => ({ title: "", body: "x" })) }, /at most 12 examples/],
      [{ email_examples: { title: "not a list" } }, /must be a list/],
    ];
    for (const [body, message] of bad) {
      const res = await w.call(configHandler, "PUT", { body: { default_model: "test/changed", ...body } });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(String(res.body.error)).toMatch(message);
    }
    expect(readAiConfig(w.ws).default_model).toBe("test/primary");
  });

  it("leaves a longer prompt from before the limit alone until someone changes it", async () => {
    const w = workspace();
    const long = "y".repeat(3000);
    db().prepare("INSERT INTO workspace_ai_config (workspace_id, system_prompt) VALUES (?, ?)").run(w.ws, long);

    expect((await w.call(configHandler, "PUT", { body: { system_prompt: long, tone: "warm" } })).statusCode).toBe(200);
    expect(readAiConfig(w.ws)).toMatchObject({ system_prompt: long, tone: "warm" });
    expect((await w.call(configHandler, "PUT", { body: { system_prompt: `${long}!` } })).statusCode).toBe(400);
  });

  it("rounds a budget to the cent", () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 49.999 });
    expect(readAiConfig(w.ws).monthly_budget_usd).toBe(50);
  });

  it("is for admins; everyone in the workspace can read", async () => {
    const w = workspace();
    for (const role of ["viewer", "member", "manager"]) {
      expect((await w.call(configHandler, "PUT", { body: { tone: "warm" }, role })).statusCode).toBe(403);
      expect((await w.call(configHandler, "GET", { role })).statusCode).toBe(200);
    }
    expect((await w.call(configHandler, "PUT", { body: { tone: "warm" }, role: "admin" })).statusCode).toBe(200);
    expect(db().prepare("SELECT action, metadata_json FROM audit_logs WHERE workspace_id = ?").all(w.ws)).toEqual([{ action: "ai_config.updated", metadata_json: JSON.stringify({ fields: ["tone"] }) }]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a request to OpenRouter", () => {
  it("goes to openrouter.ai unless the instance names another address", () => {
    expect(openrouterUrl("/chat/completions")).toBe("https://openrouter.ai/api/v1/chat/completions");
    vi.stubEnv("OPENROUTER_BASE_URL", "http://localhost:4999/v1/");
    expect(openrouterUrl("models")).toBe("http://localhost:4999/v1/models");
    vi.unstubAllEnvs();
  });

  it("is recorded with what it was for, what it cost and which model answered", async () => {
    const w = workspace();
    fetchMock.mockResolvedValueOnce(written({ subject: "Quick question", body: "Hello Lee." }, { prompt_tokens: 1200, completion_tokens: 90, cost: 0.0125 }));

    const result = await generateCommunityContent(request(w));

    expect(result).toMatchObject({ subject: "Quick question", body: "Hello Lee.", model: "test/primary", used_fallback: false, cost_usd: 0.0125, input_tokens: 1200, output_tokens: 90 });
    // Outside a campaign run it is somebody trying the writer out.
    expect(w.sessions()).toEqual([expect.objectContaining({ model: "test/primary", purpose: "test", used_fallback: 0, cost_usd: 0.0125, input_tokens: 1200, output_tokens: 90 })]);
  });

  it("is one request, and fails as it always did, when no fallback model is set", async () => {
    const w = workspace();
    fetchMock.mockResolvedValueOnce(refused(429, "Rate limit exceeded"));

    await expect(generateCommunityContent(request(w))).rejects.toThrow("Rate limit exceeded");

    expect(requestedModels()).toEqual(["test/primary"]);
    expect(w.sessions()).toEqual([]);
  });

  it("is tried once more with the fallback model when the first is rate-limited or unavailable", async () => {
    const w = workspace();
    w.config({ fallback_model: "test/backup" });
    for (const status of [429, 404, 408, 500, 503]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(refused(status)).mockResolvedValueOnce(written({ subject: "S", body: "From the backup." }));
      const result = await generateCommunityContent(request(w));
      expect(requestedModels(), `status ${status}`).toEqual(["test/primary", "test/backup"]);
      expect(result).toMatchObject({ body: "From the backup.", model: "test/backup", used_fallback: true });
    }
    expect(w.sessions().every((row) => row.model === "test/backup" && row.used_fallback === 1)).toBe(true);
    expect(usageOverview(w.ws).fallback_requests).toBe(5);
  });

  it("is tried with the fallback when OpenRouter cannot be reached at all", async () => {
    const w = workspace();
    w.config({ fallback_model: "test/backup" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(written({ subject: "S", body: "B" }));
    expect((await generateCommunityContent(request(w))).used_fallback).toBe(true);
  });

  it("is not repeated when another model would fail the same way", async () => {
    const w = workspace();
    w.config({ fallback_model: "test/backup" });
    for (const status of [400, 401, 402, 403]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(refused(status, `refused ${status}`));
      await expect(generateCommunityContent(request(w))).rejects.toThrow(`refused ${status}`);
      expect(requestedModels()).toEqual(["test/primary"]);
    }
    expect(worthTryingAnotherModel(new Error("not from OpenRouter"))).toBe(false);
    expect(worthTryingAnotherModel(new OpenRouterError(0, "unreachable"))).toBe(true);
  });

  it("is not repeated when the fallback is the model that was asked for", async () => {
    const w = workspace();
    w.config({ fallback_model: "test/primary" });
    fetchMock.mockResolvedValueOnce(refused(429));
    await expect(generateCommunityContent(request(w))).rejects.toThrow();
    expect(requestedModels()).toEqual(["test/primary"]);
  });

  it("fails with the fallback's own error when both models fail", async () => {
    const w = workspace();
    w.config({ fallback_model: "test/backup" });
    fetchMock.mockResolvedValueOnce(refused(429, "first")).mockResolvedValueOnce(refused(503, "second"));
    await expect(generateCommunityContent(request(w))).rejects.toThrow("second");
    expect(w.sessions()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the model list", () => {
  const listing = {
    data: [
      { id: "openai/gpt-x", name: "GPT X", context_length: 128000, pricing: { prompt: "0.0000025", completion: "0.00001" } },
      { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", context_length: 200000, pricing: { prompt: "0.000001", completion: "0.000005" } },
      { id: "openrouter/auto", name: "Auto Router", pricing: { prompt: "-1", completion: "-1" } },
      { id: "free/model", name: "Free", pricing: { prompt: "0", completion: "0" } },
      { id: "", name: "No id" }, { name: "Also no id" }, { id: "no/name" },
    ],
  };

  it("carries each model's price per million tokens", () => {
    expect(modelsFromListing(listing)).toEqual([
      { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "anthropic", input_price: 1, output_price: 5, context_length: 200000 },
      { id: "free/model", name: "Free", provider: "free", input_price: 0, output_price: 0, context_length: null },
      { id: "openai/gpt-x", name: "GPT X", provider: "openai", input_price: 2.5, output_price: 10, context_length: 128000 },
      // A price OpenRouter marks as varying is no price.
      { id: "openrouter/auto", name: "Auto Router", provider: "openrouter", input_price: null, output_price: null, context_length: null },
    ]);
    expect(modelsFromListing(null)).toEqual([]);
    expect(modelsFromListing({ data: "nope" })).toEqual([]);
  });

  it("is served with prices, and still with the fields the old screen read", async () => {
    const w = workspace();
    fetchMock.mockResolvedValueOnce(json(listing));
    const res = await w.call(modelsHandler, "GET", { role: "viewer" });
    expect(res.statusCode).toBe(200);
    expect((res.body.models as Array<Record<string, unknown>>)[0]).toEqual({ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "anthropic", input_price: 1, output_price: 5, context_length: 200000 });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/models");
  });

  it("is not asked for without a key", async () => {
    const w = workspace({ key: false });
    const res = await w.call(modelsHandler, "GET");
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the monthly budget", () => {
  it("is not there unless one is set: nothing is ever paused, whatever has been spent", async () => {
    const w = workspace();
    w.spent(5000);
    fetchMock.mockResolvedValue(written({ subject: "S", body: "B" }));

    expect(budgetState(w.ws)).toMatchObject({ budget_usd: null, reached: false });
    expect(() => assertWithinBudget(w.ws)).not.toThrow();
    await expect(generateCommunityContent(request(w))).resolves.toMatchObject({ body: "B" });
    expect(notes(w.ws)).toEqual([]);
    expect(events(w.ws)).toEqual([]);
  });

  it("lets writing through while this month's spend is under it", async () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    w.spent(9.5);
    fetchMock.mockResolvedValueOnce(written({ subject: "S", body: "B" }, { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 }));

    await expect(generateCommunityContent(request(w))).resolves.toMatchObject({ body: "B" });
    expect(budgetState(w.ws)).toMatchObject({ budget_usd: 10, reached: false });
    expect(notes(w.ws)).toEqual([]);
  });

  it("tells the workspace once, at the request that reaches it, and refuses the next one without calling OpenRouter", async () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    w.spent(9.99);
    fetchMock.mockResolvedValueOnce(written({ subject: "S", body: "B" }, { prompt_tokens: 10, completion_tokens: 10, cost: 0.02 }));

    // This one starts under the budget, so it is written; its cost takes the month over.
    await generateCommunityContent(request(w));
    expect(budgetState(w.ws).reached).toBe(true);
    expect(notes(w.ws)).toHaveLength(1);
    expect(notes(w.ws)[0]).toMatchObject({ tone: "warn", link: "/ai" });
    expect(notes(w.ws)[0].body).toContain("$10.01 of $10.00 spent");
    expect(events(w.ws)).toHaveLength(1);
    expect(JSON.parse(events(w.ws)[0].payload_json)).toMatchObject({ budget_usd: 10, spent_usd: 10.01 });

    fetchMock.mockClear();
    await expect(generateCommunityContent(request(w))).rejects.toBeInstanceOf(AiBudgetReachedError);
    await expect(generateCommunityContent(request(w))).rejects.toThrow(/AI budget of \$10\.00 is used up/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Still told only once.
    expect(notes(w.ws)).toHaveLength(1);
    expect(events(w.ws)).toHaveLength(1);
  });

  it("can be heard by a webhook, like any other event", () => {
    const w = workspace();
    expect(EVENT_TYPES).toContain("ai.budget_reached");
    db().prepare("INSERT INTO webhook_endpoints (id, workspace_id, url, secret, event_types, enabled) VALUES (?, ?, 'http://127.0.0.1:9/hook', 'whsec_test', 'ai.budget_reached', 1)").run(`ai-hook-${++seq}`, w.ws);
    w.config({ monthly_budget_usd: 1 });
    w.spent(0.5);
    recordAiUsage({ workspaceId: w.ws, purpose: "test", model: "test/primary", inputTokens: 1, outputTokens: 1, costUsd: 0.6 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 1 });
  });

  it("lets writing through again when it is raised, and tells the workspace again if the new one is reached", async () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    w.spent(12);
    await expect(generateCommunityContent(request(w))).rejects.toBeInstanceOf(AiBudgetReachedError);
    expect(notes(w.ws)).toHaveLength(1);

    w.config({ monthly_budget_usd: 20 });
    fetchMock.mockResolvedValueOnce(written({ subject: "S", body: "B" }, { prompt_tokens: 1, completion_tokens: 1, cost: 9 }));
    await expect(generateCommunityContent(request(w))).resolves.toMatchObject({ body: "B" });
    expect(notes(w.ws)).toHaveLength(2);
  });

  it("lets writing through again when it is taken away", async () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    w.spent(12);
    await expect(generateCommunityContent(request(w))).rejects.toBeInstanceOf(AiBudgetReachedError);
    w.config({ monthly_budget_usd: null });
    fetchMock.mockResolvedValueOnce(written({ subject: "S", body: "B" }));
    await expect(generateCommunityContent(request(w))).resolves.toMatchObject({ body: "B" });
  });

  it("counts a calendar month: what was spent last month does not count", () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const at = (iso: string) => iso.replace("T", " ").slice(0, 19);
    w.spent(50, 0, { created_at: at("2026-09-30T23:59:59") });
    w.spent(4, 0, { created_at: at("2026-10-01T00:00:00") });
    w.spent(3, 0, { created_at: at("2026-10-09T08:00:00") });

    expect(budgetState(w.ws, now)).toEqual({ budget_usd: 10, spent_usd: 7, reached: false, month: "2026-10", resets_on: "2026-11-01" });
    expect(() => assertWithinBudget(w.ws, now)).not.toThrow();
    // The same rows seen from September: that month is over its budget.
    const september = new Date(Date.UTC(2026, 8, 30, 23, 59, 59));
    expect(budgetState(w.ws, september)).toMatchObject({ spent_usd: 50, reached: true, month: "2026-09", resets_on: "2026-10-01" });
    expect(budgetState(w.ws, new Date(Date.UTC(2026, 11, 31)))).toMatchObject({ month: "2026-12", resets_on: "2027-01-01", spent_usd: 0 });
  });

  it("is reached at the budget exactly, and a request with no reported cost counts as nothing", () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 1 });
    for (let i = 0; i < 10; i++) w.spent(0.1);
    w.spent(null as unknown as number);
    expect(budgetState(w.ws).reached).toBe(true);
    expect(budgetState(w.ws).spent_usd).toBeCloseTo(1, 9);
  });

  it("belongs to its own workspace", async () => {
    const poor = workspace();
    const other = workspace();
    poor.config({ monthly_budget_usd: 1 });
    poor.spent(2);
    fetchMock.mockResolvedValueOnce(written({ subject: "S", body: "B" }));
    await expect(generateCommunityContent(request(other))).resolves.toMatchObject({ body: "B" });
    await expect(generateCommunityContent(request(poor))).rejects.toBeInstanceOf(AiBudgetReachedError);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a campaign whose email is written by AI", () => {
  /** An email-only campaign with one AI-written step, started and ready to run. */
  async function campaign(w: ReturnType<typeof workspace>) {
    const n = ++seq;
    const ids = { workflow: `ai-wf-${n}`, list: `ai-list-${n}`, mailbox: `ai-mailbox-${n}`, step: `ai-step-${n}`, target: w.contact() };
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
      VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(ids.mailbox, w.ws, `ada${n}@acme.test`);
    db().prepare("INSERT INTO workflows (id, name, workspace_id, prompt) VALUES (?, 'Campaign', ?, 'We sell to revenue teams.')").run(ids.workflow, w.ws);
    db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language)
      VALUES (?, ?, 1, 'email', 'email', 0, 1, 'test/primary', 'Lead with the funding round', 80, 'English')`).run(ids.step, ids.workflow);
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'List')").run(ids.list, w.ws);
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(ids.list, ids.target);
    const created = await w.call(runsHandler, "POST", { body: { workflow_id: ids.workflow, list_id: ids.list, email_account_ids: [ids.mailbox] }, role: "manager" });
    expect(created.statusCode).toBe(201);
    const runId = String(created.body.id);
    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    // One pass moves the contact from pending to scheduled; the step is then due.
    await tick(getDb(), { pace: false });
    const due = () => db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress' AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
    const track = () => db().prepare("SELECT rt.state, rt.next_step_at, rt.error_message, rt.current_step FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.run_id = ?").get(runId) as { state: string; next_step_at: string | null; error_message: string | null; current_step: number };
    due();
    return { ...ids, runId, due, track };
  }

  it("is written and sent, and the request is recorded against the step, when there is no budget", async () => {
    const w = workspace();
    const c = await campaign(w);
    fetchMock.mockResolvedValue(written({ subject: "About the round", body: "Hello Lee, saw the round." }, { prompt_tokens: 1000, completion_tokens: 60, cost: 0.006 }));

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([expect.objectContaining({ subject: "About the round", body: expect.stringContaining("saw the round") })]);
    expect(w.sessions()).toEqual([expect.objectContaining({ purpose: "email_opener", model: "test/primary", run_id: c.runId, target_id: c.target, step_id: c.step, cost_usd: 0.006 })]);
    expect(usageOverview(w.ws).by_purpose).toEqual([{ purpose: "email_opener", cost_usd: 0.006, requests: 1 }]);
  });

  it("waits, without failing the contact, while the month's budget is used up, and goes out once it is raised", async () => {
    const w = workspace();
    const c = await campaign(w);
    w.config({ monthly_budget_usd: 5 });
    w.spent(5);
    fetchMock.mockResolvedValue(written({ subject: "About the round", body: "Hello Lee." }));

    await tick(getDb(), { pace: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(smtp.sent).toEqual([]);
    const held = c.track();
    expect(held).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    // Tried again in about an hour.
    const wait = Date.parse(held.next_step_at!) - Date.now();
    expect(wait).toBeGreaterThan(50 * 60_000);
    expect(wait).toBeLessThan(70 * 60_000);
    expect(notes(w.ws)).toHaveLength(1);
    expect(db().prepare("SELECT level, message FROM logs WHERE run_id = ? AND message LIKE 'AI writing is paused%'").all(c.runId)).toHaveLength(1);

    // Still held on the next pass an hour later.
    c.due();
    await tick(getDb(), { pace: false });
    expect(smtp.sent).toEqual([]);
    expect(c.track().state).toBe("in_progress");

    w.config({ monthly_budget_usd: 50 });
    c.due();
    await tick(getDb(), { pace: false });
    expect(smtp.sent).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is not held by a budget when its wording is fixed: only AI-written steps wait", async () => {
    const w = workspace();
    const c = await campaign(w);
    db().prepare("UPDATE workflow_steps SET ai_enabled = 0, email_subject = 'Fixed subject', email_body = 'Fixed body' WHERE id = ?").run(c.step);
    w.config({ monthly_budget_usd: 5 });
    w.spent(50);

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([expect.objectContaining({ subject: "Fixed subject" })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("sorting a reply", () => {
  function reply(w: ReturnType<typeof workspace>, text = "Can you tell me how this compares with what we have now?") {
    const targetId = w.contact();
    const id = `ai-reply-${++seq}`;
    db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, 'lead@prospect.test', 'Re: hello', ?, datetime('now'))").run(id, w.ws, targetId, text);
    return { id, targetId };
  }
  const verdict = (kind: string) => json({ choices: [{ message: { content: JSON.stringify({ kind, confidence: 0.8, summary: "Asked a question", suggested_action: "review", return_date: null }) } }], usage: { prompt_tokens: 400, completion_tokens: 30, cost: 0.0009 } });
  const kindOf = (id: string) => JSON.parse((db().prepare("SELECT classification_json FROM email_replies WHERE id = ?").get(id) as { classification_json: string }).classification_json).kind as string;

  it("records what the request cost, as reply classification", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    const r = reply(w);
    fetchMock.mockResolvedValueOnce(verdict("human_review"));

    await classifyAndDispatch(r.id);

    expect(kindOf(r.id)).toBe("human_review");
    expect(w.sessions()).toEqual([expect.objectContaining({ purpose: "classification", model: "test/primary", cost_usd: 0.0009, input_tokens: 400, output_tokens: 30, target_id: r.targetId, run_id: null })]);
  });

  it("costs nothing, and records nothing, when the rules settle it without a model", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    const r = reply(w, "Please unsubscribe me from this list.");

    await classifyAndDispatch(r.id);

    expect(kindOf(r.id)).toBe("unsubscribe");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(w.sessions()).toEqual([]);
  });

  it("carries on when the month's budget is used up, and its cost still counts", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", monthly_budget_usd: 1 });
    w.spent(2);
    const r = reply(w);
    fetchMock.mockResolvedValueOnce(verdict("human_review"));

    await classifyAndDispatch(r.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kindOf(r.id)).toBe("human_review");
    expect(budgetState(w.ws).spent_usd).toBeCloseTo(2.0009, 6);
  });

  it("is one request, falling back to review as before, when the model fails and no fallback is set", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    const r = reply(w);
    fetchMock.mockResolvedValueOnce(refused(429));

    await classifyAndDispatch(r.id);

    expect(requestedModels()).toEqual(["test/primary"]);
    expect(JSON.parse((db().prepare("SELECT classification_json FROM email_replies WHERE id = ?").get(r.id) as { classification_json: string }).classification_json)).toMatchObject({ kind: "human_review", summary: "Classifier request failed (429)" });
    expect(w.sessions()).toEqual([]);
  });

  it("asks the fallback model when the default is rate-limited", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", fallback_model: "test/backup" });
    const r = reply(w);
    fetchMock.mockResolvedValueOnce(refused(429)).mockResolvedValueOnce(verdict("negative"));

    await classifyAndDispatch(r.id);

    expect(requestedModels()).toEqual(["test/primary", "test/backup"]);
    expect(kindOf(r.id)).toBe("negative");
    expect(w.sessions()).toEqual([expect.objectContaining({ purpose: "classification", model: "test/backup", used_fallback: 1 })]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the spend figures", () => {
  it("add up this month by what requests were for and by model, with the last fourteen days", () => {
    const w = workspace();
    const now = new Date(Date.UTC(2026, 9, 10, 15));
    const at = (day: string, time = "10:00:00") => ({ created_at: `${day} ${time}` });
    w.spent(1.5, 0, { ...at("2026-10-02"), purpose: "email_opener", model: "a/one" });
    w.spent(0.5, 0, { ...at("2026-10-02"), purpose: "email_opener", model: "a/two" });
    w.spent(0.25, 0, { ...at("2026-10-10"), purpose: "classification", model: "a/two" });
    w.spent(0.75, 0, { ...at("2026-10-09"), purpose: "linkedin_message", model: "a/one", used_fallback: 1 });
    // Last month: 2 in its first ten days (the span this month has had), 8 after.
    w.spent(2, 0, { ...at("2026-09-05"), purpose: "email_opener" });
    w.spent(8, 0, { ...at("2026-09-20"), purpose: "email_opener" });

    const usage = usageOverview(w.ws, now);

    expect(usage.month).toEqual({ key: "2026-10", spent_usd: 3, requests: 4, previous_usd: 2 });
    expect(usage.by_purpose).toEqual([
      { purpose: "email_opener", cost_usd: 2, requests: 2 },
      { purpose: "linkedin_message", cost_usd: 0.75, requests: 1 },
      { purpose: "classification", cost_usd: 0.25, requests: 1 },
    ]);
    expect(usage.by_model).toEqual([{ model: "a/one", cost_usd: 2.25, requests: 2 }, { model: "a/two", cost_usd: 0.75, requests: 2 }]);
    expect(usage.fallback_requests).toBe(1);
    expect(usage.last_used_at).toBe("2026-10-10 10:00:00");
    expect(usage.daily).toHaveLength(14);
    expect(usage.daily[0]).toEqual({ day: "2026-09-27", cost_usd: 0, requests: 0 });
    expect(usage.daily.at(-1)).toEqual({ day: "2026-10-10", cost_usd: 0.25, requests: 1 });
    expect(usage.daily.find((day) => day.day === "2026-10-02")).toEqual({ day: "2026-10-02", cost_usd: 2, requests: 2 });
    expect(usage.budget).toMatchObject({ budget_usd: null, spent_usd: 3, reached: false });
  });

  it("have nothing to compare with when last month had no spend", () => {
    const w = workspace();
    expect(usageOverview(w.ws).month).toMatchObject({ spent_usd: 0, requests: 0, previous_usd: null });
    expect(usageOverview(w.ws).last_used_at).toBeNull();
  });

  it("place requests recorded before purposes existed by their step", () => {
    const w = workspace();
    const n = ++seq;
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Old campaign', ?)").run(`ai-old-wf-${n}`, w.ws);
    const step = (id: string, type: string, track: string, position: number) =>
      db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_position) VALUES (?, ?, ?, ?, ?, 0, ?)").run(id, `ai-old-wf-${n}`, position, track, type, position);
    step(`old-open-${n}`, "email", "email", 1);
    step(`old-follow-${n}`, "email", "email", 2);
    step(`old-msg-${n}`, "message", "linkedin", 1);
    step(`old-inmail-${n}`, "sales_inmail", "linkedin", 2);
    w.spent(1, 0, { step_id: `old-open-${n}` });
    w.spent(2, 0, { step_id: `old-follow-${n}` });
    w.spent(3, 0, { step_id: `old-msg-${n}` });
    w.spent(4, 0, { step_id: `old-inmail-${n}` });
    w.spent(5, 0, { step_id: "a-step-since-removed" });
    w.spent(6, 0);

    expect(Object.fromEntries(usageOverview(w.ws).by_purpose.map((row) => [row.purpose, row.cost_usd]))).toEqual({
      email_opener: 1, email_followup: 2, linkedin_message: 3, inmail: 4, other: 5, test: 6,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the screen's first request", () => {
  it("shows a key only as its last four characters", async () => {
    const w = workspace();
    const res = await w.call(overviewHandler, "GET", { role: "viewer" });
    const body = res.body as unknown as AiOverview;

    expect(res.statusCode).toBe(200);
    expect(body.available).toBe(true);
    expect(body.provider.connected).toBe(true);
    expect(body.provider.key_hint).toMatch(/^sk-or-v1-••••••••9f3c$/);
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(keyHint("an-unusual-key-wxyz")).toBe("••••••••wxyz");
  });

  it("says when there is no key", async () => {
    const w = workspace({ key: false });
    const body = (await w.call(overviewHandler, "GET")).body as unknown as AiOverview;
    expect(body.provider).toEqual({ connected: false, key_hint: null, key_updated_at: null });
    expect(body.config).toMatchObject({ default_model: null, fallback_model: null, tone: null, monthly_budget_usd: null, email_examples: [], linkedin_examples: [] });
    expect(body.campaigns).toEqual([]);
  });

  it("lists the campaigns with steps AI could write, those already using it first", async () => {
    const w = workspace();
    const add = (name: string, steps: Array<[string, number]>, archived = 0) => {
      const id = `ai-c-${++seq}`;
      db().prepare("INSERT INTO workflows (id, name, workspace_id, is_archived) VALUES (?, ?, ?, ?)").run(id, name, w.ws, archived);
      steps.forEach(([type, ai], index) => db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled) VALUES (?, ?, ?, ?, ?, 0, ?)").run(`${id}-s${index}`, id, index + 1, type === "email" ? "email" : "linkedin", type, ai));
      return id;
    };
    add("Visits only", [["visit", 0], ["connect", 0]]);
    add("By hand", [["email", 0], ["message", 0]]);
    add("With AI", [["email", 1], ["email", 0], ["visit", 0]]);
    add("Archived with AI", [["email", 1]], 1);

    const body = (await w.call(overviewHandler, "GET", { role: "viewer" })).body as unknown as AiOverview;
    expect(body.campaigns.map((c) => [c.name, c.writable_steps, c.ai_steps, c.archived])).toEqual([
      ["With AI", 2, 1, false], ["By hand", 2, 0, false], ["Archived with AI", 1, 1, true],
    ]);
  });

  it("is not answered for another workspace's member", async () => {
    const w = workspace();
    const res = mockRes();
    await overviewHandler({ method: "GET", query: {}, body: {}, headers: {} } as unknown as NextApiRequest, res);
    expect(res.statusCode).toBe(401);
    expect((await w.call(overviewHandler, "POST")).statusCode).toBe(405);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a campaign's AI settings, step by step", () => {
  function sequence(w: ReturnType<typeof workspace>) {
    const id = `ai-seq-${++seq}`;
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Sequence', ?)").run(id, w.ws);
    const rows: Array<[string, string, string, number, Record<string, unknown>]> = [
      // LinkedIn: visit, connect, wait 2 days, message, InMail with a day's delay in front of it.
      ["visit", "linkedin", "visit", 0, {}],
      ["connect", "linkedin", "connect", 0, {}],
      ["li-wait", "linkedin", "delay", 2 * 86_400, {}],
      ["msg", "linkedin", "message", 0, { ai_enabled: 1, ai_model: "test/primary", ai_prompt: "Ask about hiring", ai_max_words: 80, ai_language: "German" }],
      ["inmail", "linkedin", "sales_inmail", 86_400, {}],
      // Email: opener, wait 3 days, follow-up, wait 6 days, break-up.
      ["e1", "email", "email", 0, { ai_enabled: 1, ai_language: "English" }],
      ["e-wait-1", "email", "delay", 3 * 86_400, {}],
      ["e2", "email", "email", 0, {}],
      ["e-wait-2", "email", "delay", 6 * 86_400, {}],
      ["e3", "email", "email", 0, {}],
    ];
    const order: Record<string, number> = {};
    for (const [key, track, type, delay, extra] of rows) {
      order[track] = (order[track] ?? 0) + 1;
      const row: Record<string, unknown> = { id: `${id}-${key}`, workflow_id: id, step_order: order[track], track, step_type: type, delay_seconds: delay, ...extra };
      const keys = Object.keys(row);
      db().prepare(`INSERT INTO workflow_steps (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
    }
    const step = (key: string) => db().prepare("SELECT ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language, step_order, step_type FROM workflow_steps WHERE id = ?").get(`${id}-${key}`) as Record<string, unknown>;
    return { id, step, sid: (key: string) => `${id}-${key}` };
  }

  it("are listed in the order they happen, with the day each falls on", () => {
    const w = workspace();
    const s = sequence(w);
    expect(aiSteps(db(), s.id).map((step) => [step.id.replace(`${s.id}-`, ""), step.step_type, step.number, step.day, step.ai_enabled])).toEqual([
      ["e1", "email", 1, 0, true],
      ["msg", "message", 1, 2, true],
      ["inmail", "sales_inmail", 1, 3, false],
      ["e2", "email", 2, 3, false],
      ["e3", "email", 3, 9, false],
    ]);
    expect(aiSteps(db(), s.id).find((step) => step.id === s.sid("msg"))).toMatchObject({ ai_model: "test/primary", ai_prompt: "Ask about hiring", ai_max_words: 80, ai_language: "German" });
    expect(aiSteps(db(), s.id).find((step) => step.id === s.sid("e1"))).toMatchObject({ ai_model: null, ai_prompt: null, ai_max_words: null });
  });

  it("can be read by anyone in the workspace and changed by a member", async () => {
    const w = workspace();
    const s = sequence(w);
    const listed = await w.call(stepsHandler, "GET", { query: { workflow_id: s.id }, role: "viewer" });
    expect(listed.statusCode).toBe(200);
    expect((listed.body.steps as unknown[]).length).toBe(5);

    expect((await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("e2"), ai_enabled: true }, role: "viewer" })).statusCode).toBe(403);
    const saved = await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("e2"), ai_enabled: true, ai_model: "test/other", ai_prompt: "  Reference the first email  ", ai_max_words: 70, ai_language: "French" }, role: "member" });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.step).toMatchObject({ id: s.sid("e2"), ai_enabled: true, ai_model: "test/other", ai_prompt: "Reference the first email", ai_max_words: 70, ai_language: "French", day: 3, number: 2 });
    expect(s.step("e2")).toMatchObject({ ai_enabled: 1, ai_model: "test/other", ai_prompt: "Reference the first email", ai_max_words: 70, ai_language: "French", step_order: 3 });
  });

  it("change only what is sent, on that step alone", async () => {
    const w = workspace();
    const s = sequence(w);
    const before = { msg: s.step("msg"), e1: s.step("e1") };

    await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("msg"), ai_model: null }, role: "member" });

    expect(s.step("msg")).toEqual({ ...before.msg, ai_model: null });
    expect(s.step("e1")).toEqual(before.e1);
    await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("msg"), ai_enabled: false, ai_max_words: null }, role: "member" });
    expect(s.step("msg")).toMatchObject({ ai_enabled: 0, ai_max_words: null, ai_prompt: "Ask about hiring", ai_language: "German" });
  });

  it("are refused when they make no sense", async () => {
    const w = workspace();
    const s = sequence(w);
    const put = (body: Record<string, unknown>) => w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("e1"), ...body }, role: "member" });
    for (const body of [{ ai_enabled: "yes" }, { ai_max_words: 0 }, { ai_max_words: 2.5 }, { ai_max_words: 5000 }, { ai_model: "two words" }, { ai_prompt: "x".repeat(1001) }, { ai_language: "x".repeat(41) }, {}, { step_order: 3 }]) {
      expect((await put(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // A step whose text nobody writes.
    expect((await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("visit"), ai_enabled: true }, role: "member" })).statusCode).toBe(400);
    expect((await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: "no-such-step", ai_enabled: true }, role: "member" })).statusCode).toBe(404);
    expect((await w.call(stepsHandler, "GET", { query: {} })).statusCode).toBe(400);
    expect(s.step("visit").ai_enabled).toBe(0);
  });

  it("cannot be read or changed from another workspace", async () => {
    const w = workspace();
    const other = workspace();
    const s = sequence(w);
    expect((await other.call(stepsHandler, "GET", { query: { workflow_id: s.id } })).statusCode).toBe(404);
    expect((await other.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("e1"), ai_enabled: false } })).statusCode).toBe(404);
    expect(s.step("e1").ai_enabled).toBe(1);
  });

  it("are carried into an unpublished draft of the same campaign, so publishing it does not undo them", async () => {
    const w = workspace();
    const s = sequence(w);
    const draft = { steps: [{ id: s.sid("e1"), step_type: "email", track: "email", email_subject: "Edited in the draft", ai_enabled: true, ai_model: null }, { id: s.sid("e2"), step_type: "email", track: "email" }], gates: [] };
    db().prepare("INSERT INTO workflow_drafts (workflow_id, workspace_id, draft_json, base_version, updated_by, updated_at) VALUES (?, ?, ?, 0, 'someone', '2026-10-01 09:00:00')").run(s.id, w.ws, JSON.stringify(draft));

    await w.call(stepsHandler, "PUT", { body: { workflow_id: s.id, step_id: s.sid("e1"), ai_model: "test/other", ai_max_words: 60 }, role: "member" });

    const stored = db().prepare("SELECT draft_json, updated_by, updated_at FROM workflow_drafts WHERE workflow_id = ?").get(s.id) as { draft_json: string; updated_by: string; updated_at: string };
    const steps = (JSON.parse(stored.draft_json) as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps[0]).toEqual({ id: s.sid("e1"), step_type: "email", track: "email", email_subject: "Edited in the draft", ai_enabled: true, ai_model: "test/other", ai_max_words: 60 });
    expect(steps[1]).toEqual({ id: s.sid("e2"), step_type: "email", track: "email" });
    // Whose draft it is, and when they last touched it, is unchanged.
    expect(stored).toMatchObject({ updated_by: "someone", updated_at: "2026-10-01 09:00:00" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("testing on a contact", () => {
  it("writes with the settings on the screen, saved or not, and says which model answered and what it cost", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", tone: "formal", system_prompt: "Saved style." });
    const target = w.contact();
    fetchMock.mockResolvedValueOnce(written({ subject: "A subject", body: "A body." }, { prompt_tokens: 800, completion_tokens: 70, cost: 0.003 }));

    const res = await w.call(testHandler, "POST", {
      role: "member",
      body: { target_id: target, step_type: "email", instruction: "Mention the round", max_words: 60, config: { tone: "warm", system_prompt: "Unsaved style.", email_examples: [{ title: "Opener", body: "Hello." }] } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ subject: "A subject", body: "A body.", model: "test/primary", used_fallback: false, input_tokens: 800, output_tokens: 70, cost_usd: 0.003 });
    const sent = JSON.parse(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages[1].content) as Record<string, unknown> & { instructions: string[]; examples: { email: string } };
    expect(sent.global_system_prompt).toBe("Unsaved style.");
    expect(sent.step_instruction).toBe("Mention the round");
    expect(sent.instructions).toContain(TONE_INSTRUCTION.warm);
    expect(sent.instructions).toContain("Keep the body at or below 60 words.");
    expect(sent.examples.email).toBe("Example 1: Opener\nHello.");
    // Nothing on the screen was saved by testing it.
    expect(readAiConfig(w.ws)).toMatchObject({ tone: "formal", system_prompt: "Saved style.", email_examples: [] });
    expect(w.sessions()).toEqual([expect.objectContaining({ purpose: "test", target_id: target, cost_usd: 0.003 })]);
  });

  it("writes a LinkedIn message with no subject", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    fetchMock.mockResolvedValueOnce(written({ body: "Hi Lee." }));
    const res = await w.call(testHandler, "POST", { role: "member", body: { target_id: w.contact(), step_type: "message" } });
    expect(res.body).toMatchObject({ subject: null, body: "Hi Lee." });
  });

  it("uses the unsaved fallback model too", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    fetchMock.mockResolvedValueOnce(refused(429)).mockResolvedValueOnce(written({ subject: "S", body: "B" }));
    const res = await w.call(testHandler, "POST", { role: "member", body: { target_id: w.contact(), step_type: "email", config: { fallback_model: "test/backup" } } });
    expect(res.body).toMatchObject({ model: "test/backup", used_fallback: true });
  });

  it("says why it cannot run", async () => {
    const w = workspace();
    const target = w.contact();
    const post = (body: Record<string, unknown>, role = "member") => w.call(testHandler, "POST", { role, body });

    expect((await post({ target_id: target, step_type: "email" }, "viewer")).statusCode).toBe(403);
    expect(await post({ target_id: target, step_type: "email" })).toMatchObject({ statusCode: 400, body: { error: "Choose a default model before testing" } });
    w.config({ default_model: "test/primary" });
    expect((await post({ target_id: target, step_type: "connect" })).statusCode).toBe(400);
    expect((await post({ step_type: "email" })).statusCode).toBe(400);
    expect((await post({ target_id: workspace().contact(), step_type: "email" })).statusCode).toBe(404);

    const keyless = workspace({ key: false });
    keyless.config({ default_model: "test/primary" });
    expect(await keyless.call(testHandler, "POST", { role: "member", body: { target_id: keyless.contact(), step_type: "email" } })).toMatchObject({ statusCode: 400, body: { error: "Add an OpenRouter or Google Gemini key before testing" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused, with nothing sent to OpenRouter, when the month's budget is used up", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary", monthly_budget_usd: 1 });
    w.spent(1);
    const body = { target_id: w.contact(), step_type: "email" };

    const res = await w.call(testHandler, "POST", { role: "member", body });
    expect(res).toMatchObject({ statusCode: 409, body: { code: "budget_reached" } });
    // The older preview route, which the MCP tool calls, answers the same way.
    const preview = await w.call(previewHandler, "POST", { role: "member", body: { ...body, ai_model: "test/primary" } });
    expect(preview).toMatchObject({ statusCode: 409, body: { code: "budget_reached" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes on OpenRouter's own message when the request fails", async () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    fetchMock.mockResolvedValueOnce(refused(401, "No auth credentials found"));
    const res = await w.call(testHandler, "POST", { role: "member", body: { target_id: w.contact(), step_type: "email" } });
    expect(res).toMatchObject({ statusCode: 502, body: { error: "No auth credentials found" } });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("what needs attention", () => {
  function aiStep(w: ReturnType<typeof workspace>, fields: { model?: string | null; archived?: boolean; enabled?: boolean } = {}) {
    const id = `ai-att-${++seq}`;
    db().prepare("INSERT INTO workflows (id, name, workspace_id, is_archived) VALUES (?, 'Campaign', ?, ?)").run(id, w.ws, fields.archived ? 1 : 0);
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled, ai_model) VALUES (?, ?, 1, 'email', 'email', 0, ?, ?)").run(`${id}-s`, id, fields.enabled === false ? 0 : 1, fields.model ?? null);
  }
  const codes = (w: ReturnType<typeof workspace>) => aiAttention(w.ws).map((notice) => notice.code);

  it("is nothing for a workspace that does not use AI, with or without a key", () => {
    expect(aiAttention(workspace({ key: false }).ws)).toEqual([]);
    const w = workspace();
    aiStep(w, { enabled: false });
    expect(aiAttention(w.ws)).toEqual([]);
  });

  it("is nothing when AI steps have a key and a model to write with", () => {
    const w = workspace();
    w.config({ default_model: "test/primary" });
    aiStep(w);
    aiStep(w, { model: "test/other" });
    expect(aiAttention(w.ws)).toEqual([]);
  });

  it("says when steps set to be written by AI have no key to write with", () => {
    const w = workspace({ key: false });
    w.config({ default_model: "test/primary" });
    aiStep(w);
    aiStep(w);
    aiStep(w, { archived: true });
    expect(aiAttention(w.ws)).toEqual([expect.objectContaining({ code: "no_key", tone: "bad", link: "/ai", title: "2 steps are set to be written by AI, and no AI provider is connected" })]);
  });

  it("says when steps rely on a default model that has not been chosen", () => {
    const w = workspace();
    aiStep(w, { model: "test/own" });
    expect(codes(w)).toEqual([]);
    aiStep(w);
    expect(aiAttention(w.ws)).toEqual([expect.objectContaining({ code: "no_model", title: "1 step is written by AI with no model chosen" })]);
  });

  it("says when the budget is nearly spent, and when it is", () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 10 });
    w.spent(7.9);
    expect(codes(w)).toEqual([]);
    w.spent(0.2);
    expect(aiAttention(w.ws)).toEqual([expect.objectContaining({ code: "budget_nearly", tone: "warn", title: "81% of this month's AI budget is spent" })]);
    w.spent(2);
    expect(aiAttention(w.ws)).toEqual([expect.objectContaining({ code: "budget_reached", tone: "bad", title: "AI writing is paused: this month's budget of $10.00 is used up" })]);
  });

  it("is part of the screen's first request", async () => {
    const w = workspace();
    w.config({ monthly_budget_usd: 1 });
    w.spent(1);
    const body = (await w.call(overviewHandler, "GET", { role: "viewer" })).body as unknown as AiOverview;
    expect(body.attention.map((notice) => notice.code)).toEqual(["budget_reached"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the contacts offered for a test", () => {
  it("are the newest with a name, from this workspace only", async () => {
    const w = workspace();
    const other = workspace();
    other.contact({ name: "Someone Else" });
    const first = w.contact({ name: "Ada First" });
    const second = w.contact({ name: "Bo Second" });
    db().prepare("UPDATE targets SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(first);
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, '', ?)").run(`ai-target-${++seq}`, w.ws, `https://www.linkedin.com/in/nameless-${seq}/`);

    const res = await w.call(testHandler, "GET", { role: "member" });

    expect(res.statusCode).toBe(200);
    expect(res.body.contacts).toEqual([
      { id: second, name: "Bo Second", detail: "VP Sales · Northwind" },
      { id: first, name: "Ada First", detail: "VP Sales · Northwind" },
    ]);
    expect((await w.call(testHandler, "GET", { role: "viewer" })).statusCode).toBe(403);
    expect((await w.call(testHandler, "DELETE", { role: "member" })).statusCode).toBe(405);
  });
});
