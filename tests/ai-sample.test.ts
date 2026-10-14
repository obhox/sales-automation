// A step AI writes, tried out before it runs: one sample for one contact, and that sample sent
// to yourself as a test. Real (throwaway) database; the AI provider and the mail server are stubs.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string, options: { messageId: string }) => { smtp.sent.push({ to, subject, body }); return { messageId: options.messageId }; },
}));

import { recordAiUsage } from "@/lib/ai/usage";
import { saveAiConfig } from "@/lib/ai/config";
import { saveAiContext } from "@/lib/campaigns/context";
import { earlierEmail } from "@/lib/outreach/ai-sample";
import type { StepInput } from "@/lib/outreach/publish";
import aiSampleHandler from "@/pages/api/workflows/[id]/ai-sample";
import testSendHandler from "@/pages/api/workflows/[id]/test-send";

const db = () => getDb();
let seq = 0;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterAll(() => vi.unstubAllGlobals());

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
const written = (content: Record<string, unknown>, usage: Record<string, unknown> = { prompt_tokens: 800, completion_tokens: 100, cost: 0.003 }) =>
  json({ choices: [{ message: { content: JSON.stringify(content) } }], usage });
/** The requests that went to the AI provider (the app's own update check also goes through fetch). */
const requests = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("openrouter.ai"));
/** What the writer was asked: the prompt of the nth request, as data. */
const asked = (n = 0) => {
  const body = JSON.parse(String((requests()[n][1] as RequestInit).body)) as { model: string; messages: Array<{ role: string; content: string }> };
  return { model: body.model, prompt: JSON.parse(body.messages.find((message) => message.role === "user")!.content) as Record<string, unknown> };
};

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with an AI key, a mailbox with a signature, a user, and a campaign. */
function campaign(opts: { key?: boolean; prompt?: string } = {}) {
  const n = ++seq;
  const c = { ws: `ws-sample-${n}`, workflow: `sample-wf-${n}`, mailbox: `sample-mail-${n}`, user: `sample-user-${n}`, email: `sam${n}@acme.test` };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(c.ws, c.ws, c.ws);
  if (opts.key !== false) db().prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'openrouter', ?)").run(c.ws, encryptSecret(`sk-or-v1-sample-${n}-9f3c`));
  db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Sam Sender', 'x')").run(c.user, c.email);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_name, from_email, signature, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled)
    VALUES (?, ?, 'Outbound', 'Ada Okafor', ?, 'Ada, Acme', 'smtp.test.com', 'user', 'pass', 1, 50, 0)`).run(c.mailbox, c.ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id, prompt) VALUES (?, 'Campaign', ?, ?)").run(c.workflow, c.ws, opts.prompt ?? null);
  return c;
}
type Campaign = ReturnType<typeof campaign>;
const as = (c: Campaign, role: "viewer" | "member" | "manager" | "admin" = "member") => ctxHeaders(c.ws, { userId: c.user, role });

function contact(c: Campaign) {
  const id = `sample-target-${++seq}`;
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, title, email, email_status, email_verified_at, linkedin_url)
    VALUES (?, ?, ?, 'Lee', 'Initech', 'VP Sales', ?, 'verified', datetime('now'), ?)`).run(id, c.ws, `Lee Lead ${seq}`, `lead${seq}@prospect.test`, `https://www.linkedin.com/in/sample-${seq}/`);
  return id;
}

const aiEmail: StepInput = { step_type: "email", ai_enabled: 1, ai_prompt: "Open with their hiring push, then ask for 15 minutes.", ai_model: "test/step-model", ai_max_words: 90, ai_language: "English", email_position: 1 };
const post = (c: Campaign, body: Record<string, unknown>, role: "viewer" | "member" = "member") =>
  call(aiSampleHandler, { method: "POST", query: { id: c.workflow }, body, headers: as(c, role) });

beforeEach(() => {
  fetchMock.mockReset();
  smtp.sent.length = 0;
});

describe("writing a sample of an AI step", () => {
  it("writes one for the contact, with what the runner would give the writer, and shows it as it will be read", async () => {
    const c = campaign({ prompt: "We sell payroll software to growing teams." });
    saveAiContext(db(), c.workflow, { angle: "hiring-driven capacity gap" });
    fetchMock.mockResolvedValueOnce(written({ subject: "Hiring at Initech", body: "Hi Lee,\n\nSaw the hiring push." }));

    const res = await post(c, { step: aiEmail, target_id: contact(c), email_account_id: c.mailbox });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ model: "test/step-model", used_fallback: false, without_previous: false, cost_usd: 0.003, input_tokens: 800, output_tokens: 100 });
    expect(res.body.sample).toMatchObject({ step_type: "email", content: "text", subject: "Hiring at Initech", body: "Hi Lee,\n\nSaw the hiring push.", signature: "Ada, Acme" });
    const request = asked();
    expect(request.model).toBe("test/step-model");
    expect(request.prompt).toMatchObject({ task: "email", step_instruction: aiEmail.ai_prompt, contact: expect.objectContaining({ company: "Initech" }) });
    expect(String(request.prompt.campaign_context)).toContain("We sell payroll software");
    expect(String(request.prompt.campaign_context)).toContain("Angle: hiring-driven capacity gap");
    // Nothing was sent, and the request is on the record as a trial of the writer.
    expect(smtp.sent).toHaveLength(0);
    expect(db().prepare("SELECT purpose, model FROM agent_sessions WHERE workspace_id = ?").all(c.ws)).toEqual([{ purpose: "test", model: "test/step-model" }]);
  });

  it("uses the campaign's model, then the workspace's, when the step names none", async () => {
    const c = campaign();
    saveAiConfig(c.ws, { default_model: "test/workspace-model" });
    fetchMock.mockImplementation(async () => written({ subject: "S", body: "B" }));
    const step = { ...aiEmail, ai_model: null };

    await post(c, { step, target_id: contact(c) });
    expect(asked(0).model).toBe("test/workspace-model");

    saveAiContext(db(), c.workflow, { model: "test/campaign-model" });
    await post(c, { step, target_id: contact(c) });
    expect(asked(1).model).toBe("test/campaign-model");
  });

  it("gives a follow-up the email before it when it is supplied, and says so when it is not", async () => {
    const c = campaign();
    fetchMock.mockImplementation(async () => written({ subject: "Re: Hiring", body: "Following up." }));
    const followUp = { ...aiEmail, email_position: 2 };

    const withEarlier = await post(c, { step: followUp, target_id: contact(c), previous: { subject: "Hiring at Initech", body: "Hi Lee, saw the hiring push." } });
    expect(withEarlier.body.without_previous).toBe(false);
    expect(asked(0).prompt.previous_email).toMatchObject({ followupNumber: 1, previousSubject: "Hiring at Initech", previousBody: "Hi Lee, saw the hiring push." });

    const without = await post(c, { step: followUp, target_id: contact(c) });
    expect(without.body.without_previous).toBe(true);
    expect(asked(1).prompt.previous_email).toBeNull();
  });

  it("writes a LinkedIn message too, with no subject", async () => {
    const c = campaign();
    fetchMock.mockResolvedValueOnce(written({ body: "Hi Lee, congrats on the launch." }));
    const res = await post(c, { step: { step_type: "message", ai_enabled: 1, ai_prompt: "Congratulate them.", ai_model: "test/m" }, target_id: contact(c) });
    expect(res.body.sample).toMatchObject({ step_type: "message", subject: null, body: "Hi Lee, congrats on the launch." });
  });

  it("says what is missing instead of failing quietly", async () => {
    const noKey = campaign({ key: false });
    expect((await post(noKey, { step: aiEmail, target_id: contact(noKey) })).body.error).toMatch(/Add an OpenRouter or Google Gemini key/);

    const c = campaign();
    expect((await post(c, { step: { ...aiEmail, ai_model: null }, target_id: contact(c) })).body.error).toMatch(/Choose a model/);
    expect((await post(c, { step: { ...aiEmail, ai_enabled: 0 }, target_id: contact(c) })).body.error).toBe("This step is not written by AI");
    expect((await post(c, { step: aiEmail })).statusCode).toBe(400);
    expect((await post(c, { step: aiEmail, target_id: "nobody" })).statusCode).toBe(404);
    expect(requests()).toHaveLength(0);
  });

  it("will not write for a contact of another workspace, or for a viewer", async () => {
    const c = campaign();
    const other = campaign();
    expect((await post(c, { step: aiEmail, target_id: contact(other) })).statusCode).toBe(404);
    expect((await post(c, { step: aiEmail, target_id: contact(c) }, "viewer")).statusCode).toBe(403);
    expect(requests()).toHaveLength(0);
  });

  it("stops at the month's budget, before asking the model", async () => {
    const c = campaign();
    saveAiConfig(c.ws, { monthly_budget_usd: 1 });
    recordAiUsage({ workspaceId: c.ws, purpose: "test", model: "test/m", usedFallback: false, inputTokens: 1, outputTokens: 1, costUsd: 5, prompt: "", generatedText: "" });
    const res = await post(c, { step: aiEmail, target_id: contact(c) });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("budget_reached");
    expect(requests()).toHaveLength(0);
  });

  it("reports a provider failure as one, with its words", async () => {
    const c = campaign();
    fetchMock.mockResolvedValueOnce(json({ error: { message: "model is down" } }, 500));
    const res = await post(c, { step: aiEmail, target_id: contact(c) });
    expect(res.statusCode).toBe(502);
    expect(String(res.body.error)).toContain("model is down");
  });
});

describe("sending an AI step as a test", () => {
  const send = (c: Campaign, body: Record<string, unknown>, role: "member" | "admin" = "member") =>
    call(testSendHandler, { method: "POST", query: { id: c.workflow }, body: { email_account_id: c.mailbox, ...body }, headers: as(c, role) });

  it("sends the sample that was read, as written, without asking the model again", async () => {
    const c = campaign();
    const res = await send(c, { step: aiEmail, target_id: contact(c), sample: { subject: "Hiring at Initech", body: "Hi Lee,\n\nSaw the hiring push." } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, to: c.email, subject: "[Test] Hiring at Initech", generated: true, model: null });
    expect(requests()).toHaveLength(0);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0].to).toBe(c.email);
    expect(smtp.sent[0].body).toContain("Saw the hiring push.");
    expect(smtp.sent[0].body).toContain("Ada, Acme");
  });

  it("writes one now when none was supplied", async () => {
    const c = campaign();
    fetchMock.mockResolvedValueOnce(written({ subject: "Quick one", body: "Hello Lee." }));
    const res = await send(c, { step: aiEmail, target_id: contact(c) });
    expect(res.body).toMatchObject({ ok: true, subject: "[Test] Quick one", generated: true, model: "test/step-model" });
    expect(smtp.sent[0].body).toContain("Hello Lee.");
  });

  it("keeps the test away from anyone it was written for, and from a stranger's inbox", async () => {
    const c = campaign();
    const lee = contact(c);
    const refused = await send(c, { step: aiEmail, target_id: lee, sample: { subject: "S", body: "B" }, to: "boss@elsewhere.test" });
    expect(refused.statusCode).toBe(403);
    expect(smtp.sent).toHaveLength(0);
    // The contact is never the recipient.
    await send(c, { step: aiEmail, target_id: lee, sample: { subject: "S", body: "B" } });
    expect(smtp.sent.map((mail) => mail.to)).toEqual([c.email]);
  });

  it("does not send an empty sample", async () => {
    const c = campaign();
    fetchMock.mockResolvedValueOnce(json({ error: { message: "down" } }, 500));
    const res = await send(c, { step: aiEmail, target_id: contact(c), sample: { subject: "S", body: "   " } });
    expect(res.statusCode).toBe(502);
    expect(smtp.sent).toHaveLength(0);
  });
});

describe("the earlier email a caller supplies", () => {
  it("is used only when it has a body, and is cut to a sane size", () => {
    expect(earlierEmail(null)).toBeNull();
    expect(earlierEmail("text")).toBeNull();
    expect(earlierEmail({ subject: "S", body: "  " })).toBeNull();
    expect(earlierEmail({ subject: 4, body: "B" })).toEqual({ subject: "", body: "B" });
    expect(earlierEmail({ subject: "S".repeat(500), body: "B".repeat(30_000) })).toEqual({ subject: "S".repeat(300), body: "B".repeat(20_000) });
  });
});
