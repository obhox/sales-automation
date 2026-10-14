// What the sequence builder leans on: sender and custom merge tags, templates for email as
// well as LinkedIn, an email step sending from a pool of templates, the whole sequence
// previewed for one contact, a test send, who may publish, and the AI rewrite.
// Real (throwaway) database; the browser, the SMTP send and the model are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string, options: { messageId: string }) => { smtp.sent.push({ to, subject, body }); return { messageId: options.messageId }; },
}));
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/message", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/message")>()),
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { sendMessage } from "@/lib/linkedin/message";
import { buildRewritePrompt, parseRewrite, rewriteProblem, tagChanges } from "@/lib/ai/rewrite";
import { builderData, canPublish } from "@/lib/campaigns/builder";
import { encryptSecret } from "@/lib/crypto";
import { buildEmailContent, toPlainText } from "@/lib/email/content";
import { previewContact, previewSenders, previewSequence, stepDays } from "@/lib/outreach/preview";
import { publishDraft, saveDraft, type GateInput, type StepInput } from "@/lib/outreach/publish";
import { lintTemplate, renderOutreachTemplate, senderOf } from "@/lib/outreach/render";
import { createTemplate, listTemplates, templateCategories, templateProblem, updateTemplate } from "@/lib/templates/library";
import rewriteHandler from "@/pages/api/ai/rewrite";
import runsHandler from "@/pages/api/runs";
import templatesHandler from "@/pages/api/templates";
import templateHandler from "@/pages/api/templates/[id]";
import builderHandler from "@/pages/api/workflows/[id]/builder";
import previewHandler from "@/pages/api/workflows/[id]/preview";
import publishHandler from "@/pages/api/workflows/[id]/publish";
import testSendHandler from "@/pages/api/workflows/[id]/test-send";
import { ctxHeaders } from "./helpers/ctx";

const message = vi.mocked(sendMessage);
const db = () => getDb();
let seq = 0;
const DAY = 86_400;

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with a LinkedIn account and a mailbox (both awake all day, every day), a list, a user of each role, and a campaign with this sequence published. */
function campaign(steps: StepInput[], gates: GateInput[] = []) {
  const n = ++seq;
  const ws = `ws-bld-${n}`;
  const c = { ws, workflow: `bld-wf-${n}`, list: `bld-list-${n}`, account: `bld-li-${n}`, mailbox: `bld-mail-${n}`, user: `bld-user-${n}`, steps: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Morgan Member', 'x')").run(c.user, `morgan${n}@acme.test`);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'Jordan Mertens', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.account, `bld${n}@example.test`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_name, from_email, signature, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Outbound 1', 'Ada Okafor', ?, 'Ada, Acme', 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(c.workflow, ws);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'List')").run(c.list, ws);
  const published = publishDraft(db(), ws, c.workflow, { steps, gates });
  for (const step of published.steps) if (step.key) c.steps[step.key] = step.id;
  return c;
}
type Campaign = ReturnType<typeof campaign>;
const as = (c: Campaign, role: "viewer" | "member" | "manager" | "admin") => ctxHeaders(c.ws, { userId: c.user, role });

function contact(c: Campaign, fields: Record<string, unknown> = {}) {
  const k = ++seq;
  const id = `bld-target-${k}`;
  // Already a first-degree connection, so a message step has someone it may write to.
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, title, email, email_status, email_verified_at, linkedin_url, degree)
    VALUES (?, ?, ?, 'Lee', 'Initech', 'VP Sales', ?, 'verified', datetime('now'), ?, 1)`)
    .run(id, c.ws, `Lee Lead ${k}`, `lead${k}@prospect.test`, `https://www.linkedin.com/in/bld-lead-${k}/`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(c.list, id);
  return id;
}

async function start(c: Campaign) {
  const res = await call(runsHandler, { method: "POST", body: { workflow_id: c.workflow, list_id: c.list, account_id: c.account, email_account_ids: [c.mailbox] }, headers: as(c, "manager") });
  expect(res.statusCode).toBe(201);
  const runId = String(res.body.id);
  db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  db().prepare("UPDATE run_profile_tracks SET state = 'in_progress', next_step_at = datetime('now', '-1 minute') WHERE hold IS NULL AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
  return runId;
}

beforeEach(() => {
  // Runs left over from an earlier test would be picked up by the next tick.
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused')").run();
  smtp.sent.length = 0;
  message.mockReset();
  message.mockResolvedValue("sent");
});
afterEach(() => vi.unstubAllGlobals());

describe("merge tags for the sender and for custom fields", () => {
  const lee = { first_name: "Lee", company: "Initech" };

  it("fills {{sender.…}} from whoever the message goes out from", () => {
    const sender = senderOf({ from_name: "Ada Okafor", name: "Outbound 1", from_email: "ada@acme.test" });
    expect(renderOutreachTemplate("{{sender.first_name}} here. {{sender.name}} <{{sender.email}}>", lee, {}, { sender })).toBe("Ada here. Ada Okafor <ada@acme.test>");
    // A mailbox with no display name signs as its label.
    expect(renderOutreachTemplate("{{sender.name}}", lee, {}, { sender: senderOf({ from_name: null, name: "Outbound 1" }) })).toBe("Outbound 1");
    expect(renderOutreachTemplate("{{sender.email|us}}", lee, {}, { sender: { name: "Jordan", email: null } })).toBe("us");
  });

  it("leaves a sender tag as written when nobody is given, so a preview shows what is missing", () => {
    expect(renderOutreachTemplate("From {{sender.name}}", lee, {})).toBe("From {{sender.name}}");
    expect(renderOutreachTemplate("From {{sender.name|the team}}", lee, {})).toBe("From the team");
    expect(renderOutreachTemplate("{{sender.shoe_size}}", lee, {}, { sender: { name: "Ada" } })).toBe("{{sender.shoe_size}}");
  });

  it("reads {{custom.key}} as the same field as the bare {{key}}", () => {
    const custom = { trigger: "You just raised a Series B.", Segment: "" };
    expect(renderOutreachTemplate("{{custom.trigger}} / {{trigger}}", lee, custom)).toBe("You just raised a Series B. / You just raised a Series B.");
    expect(renderOutreachTemplate("{{custom.segment|your team}}", lee, custom)).toBe("your team");
    expect(renderOutreachTemplate("{{custom.nope}}", lee, custom)).toBe("{{custom.nope}}");
    // The prefix cannot be used to reach a contact's own columns under another name.
    expect(renderOutreachTemplate("{{custom.first_name}}", lee, custom)).toBe("{{custom.first_name}}");
  });

  it("knows both kinds when checking a template, and says which kind an unknown one is", () => {
    expect(lintTemplate("{{sender.first_name}} {{custom.trigger}} {{trigger}}", ["trigger"])).toEqual([]);
    expect(lintTemplate("{{custom.nope}}", ["trigger"])).toEqual(["{{custom.nope}} is not one of this workspace's custom fields. It will be sent as written."]);
    expect(lintTemplate("{{sender.title}}")).toEqual(["{{sender.title}} is not something known about the sender. It will be sent as written."]);
  });
});

describe("templates for email as well as LinkedIn", () => {
  it("keeps a subject only on an email template, and groups by category", () => {
    const c = campaign([]);
    const intro = createTemplate(db(), c.ws, { name: "Intro A", body: "Hi {{first_name}}", channel: "email", subject: "Quick one", category: "Enterprise intros" });
    const nudge = createTemplate(db(), c.ws, { name: "Nudge", body: "Following up", subject: "ignored", category: "Enterprise intros" });
    expect(intro).toMatchObject({ channel: "email", subject: "Quick one", category: "Enterprise intros" });
    expect(nudge).toMatchObject({ channel: "linkedin", subject: null });
    expect(listTemplates(db(), c.ws, { channel: "email" }).map((template) => template.name)).toEqual(["Intro A"]);
    expect(listTemplates(db(), c.ws).length).toBe(2);
    expect(templateCategories(db(), c.ws)).toEqual([{ category: "Enterprise intros", channel: "email", templates: 1 }, { category: "Enterprise intros", channel: "linkedin", templates: 1 }]);

    // Changing only the name keeps the rest; an empty category clears it; moving to LinkedIn drops the subject.
    expect(updateTemplate(db(), c.ws, intro.id, { name: "Intro B" })).toMatchObject({ name: "Intro B", body: "Hi {{first_name}}", subject: "Quick one", category: "Enterprise intros" });
    expect(updateTemplate(db(), c.ws, intro.id, { category: "" })).toMatchObject({ category: null, subject: "Quick one" });
    expect(updateTemplate(db(), c.ws, intro.id, { channel: "linkedin" })).toMatchObject({ channel: "linkedin", subject: null });
    expect(updateTemplate(db(), c.ws, "no-such-template", { name: "x" })).toBeNull();
  });

  it("says what is wrong with a template before saving it", () => {
    expect(templateProblem({ name: "x" }, true)).toBe("name and body required");
    expect(templateProblem({ name: "x", body: "y", channel: "sms" }, true)).toBe("channel must be one of linkedin, email");
    expect(templateProblem({ body: "  " }, false)).toBe("body cannot be empty");
    expect(templateProblem({ subject: 4 }, false)).toBe("subject must be text");
    expect(templateProblem({ category: "Intros" }, false)).toBeNull();
  });

  it("serves them through the routes, which every existing caller can still use unchanged", async () => {
    const c = campaign([]);
    const created = await call(templatesHandler, { method: "POST", body: { name: "Plain", body: "Hello" }, headers: as(c, "member") });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ name: "Plain", channel: "linkedin", subject: null, category: null });
    const email = await call(templatesHandler, { method: "POST", body: { name: "Mail", body: "Hello", channel: "email", subject: "Hi" }, headers: as(c, "member") });
    expect((await call(templatesHandler, { method: "GET", query: { channel: "email" }, headers: as(c, "viewer") })).body).toHaveLength(1);
    expect((await call(templatesHandler, { method: "POST", body: { name: "Bad", body: "x", channel: "fax" }, headers: as(c, "member") })).statusCode).toBe(400);
    expect((await call(templatesHandler, { method: "POST", body: { name: "No", body: "x" }, headers: as(c, "viewer") })).statusCode).toBe(403);

    const updated = await call(templateHandler, { method: "PUT", query: { id: String(email.body.id) }, body: { subject: "Hello again", category: "Intros" }, headers: as(c, "member") });
    expect(updated.body).toMatchObject({ name: "Mail", subject: "Hello again", category: "Intros" });
    expect((await call(templateHandler, { method: "PUT", query: { id: "nope" }, body: { name: "x" }, headers: as(c, "member") })).statusCode).toBe(404);
  });
});

describe("what the runner sends", () => {
  it("fills the sender's details in an email, from the mailbox it goes out of", async () => {
    const c = campaign([{ key: "e1", step_type: "email", email_subject: "From {{sender.first_name}}", email_body: "Hi {{first_name}}, {{sender.name}} at Acme here. Reply to {{sender.email}}." }]);
    const lee = contact(c);
    await start(c);
    await tick(db(), { pace: false });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0].subject).toBe("From Ada");
    expect(smtp.sent[0].body).toContain(`Hi Lee, Ada Okafor at Acme here. Reply to ada${c.mailbox.split("-").pop()}@acme.test.`);
    expect(db().prepare("SELECT template_id FROM step_sends WHERE target_id = ?").get(lee)).toEqual({ template_id: null });
  });

  it("signs a LinkedIn message as the account that sends it, and never gives out its sign-in address", async () => {
    const c = campaign([{ key: "m1", step_type: "message", message_body: "{{sender.first_name}} here. {{sender.email|No address}}." }]);
    contact(c);
    await start(c);
    await tick(db(), { pace: false });
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0]).toContain("Jordan here. No address.");
  });

  it("sends an email step's pooled template in place of its own text, and records which", async () => {
    const c = campaign([{ key: "e1", step_type: "email", email_subject: "The step's own subject", email_body: "The step's own body" }]);
    const withSubject = createTemplate(db(), c.ws, { name: "Pooled", body: "Pooled body for {{first_name}}", channel: "email", subject: "Pooled subject" });
    db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(c.steps.e1, withSubject.id);
    const lee = contact(c);
    await start(c);
    await tick(db(), { pace: false });
    expect(smtp.sent[0]).toMatchObject({ subject: "Pooled subject" });
    expect(smtp.sent[0].body).toContain("Pooled body for Lee");
    expect(db().prepare("SELECT template_id, variant_id FROM step_sends WHERE target_id = ?").get(lee)).toEqual({ template_id: withSubject.id, variant_id: null });
  });

  it("puts a pooled template with no subject under the step's subject", async () => {
    const c = campaign([{ key: "e1", step_type: "email", email_subject: "The step's own subject", email_body: "The step's own body" }]);
    const bare = createTemplate(db(), c.ws, { name: "Bare", body: "Only a body", channel: "email" });
    db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(c.steps.e1, bare.id);
    contact(c);
    await start(c);
    await tick(db(), { pace: false });
    expect(smtp.sent[0]).toMatchObject({ subject: "The step's own subject" });
    expect(smtp.sent[0].body).toContain("Only a body");
  });

  it("ignores a template written for the other channel", async () => {
    const c = campaign([
      { key: "m1", step_type: "message", message_body: "The message as written" },
      { key: "e1", step_type: "email", email_subject: "Subject as written", email_body: "Email as written" },
    ]);
    const emailTemplate = createTemplate(db(), c.ws, { name: "An email", body: "EMAIL TEMPLATE", channel: "email", subject: "S" });
    const linkedinTemplate = createTemplate(db(), c.ws, { name: "A message", body: "LINKEDIN TEMPLATE" });
    db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(c.steps.m1, emailTemplate.id);
    db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(c.steps.e1, linkedinTemplate.id);
    contact(c);
    await start(c);
    await tick(db(), { pace: false });
    expect(message.mock.calls[0]).toContain("The message as written");
    expect(smtp.sent[0]).toMatchObject({ subject: "Subject as written" });
    expect(smtp.sent[0].body).toContain("Email as written");
  });
});

describe("the sequence previewed for one contact", () => {
  const steps: StepInput[] = [
    { key: "v", step_type: "visit" },
    { step_type: "delay", track: "linkedin", delay_seconds: DAY },
    { key: "c", step_type: "connect", connect_note: "Hi {{first_name}}, {{sender.first_name}} here." },
    { step_type: "delay", track: "linkedin", delay_seconds: 3 * DAY },
    { key: "m", step_type: "message", message_body: "Thanks for connecting, {{first_name}}." },
    { step_type: "delay", track: "email", delay_seconds: DAY },
    { key: "e1", step_type: "email", email_subject: "{{company}} + hiring", email_body: "Hi {{first_name}}\n\n{{unsubscribe}}", email_variants: [{ subject: "Version B", body: "B for {{frist_name}}" }] },
    { step_type: "delay", track: "email", delay_seconds: 12 * 3600 },
    { key: "e2", step_type: "email", ai_enabled: 1, ai_prompt: "Follow up" },
  ];

  it("works out the day each step falls on from the waits before it, track by track", () => {
    const days = stepDays(steps);
    expect(steps.filter((step) => step.step_type !== "delay").map((step) => [step.key, days.get(step)])).toEqual([["v", 1], ["c", 2], ["m", 5], ["e1", 2], ["e2", 2]]);
  });

  it("writes every step out as the contact would read it, and says where AI will write", () => {
    const c = campaign(steps);
    const lee = previewContact(db(), c.ws, contact(c))!;
    const senders = previewSenders(db(), c.ws, c.workflow, { emailAccountId: c.mailbox, accountId: c.account });
    const preview = previewSequence(db(), c.ws, lee, { steps }, senders);
    expect(preview.map((step) => [step.ref, step.day, step.content])).toEqual([["v", 1, "none"], ["c", 2, "text"], ["m", 5, "text"], ["e1", 2, "text"], ["e2", 2, "ai"]]);
    expect(preview[1].body).toBe("Hi Lee, Jordan here.");
    expect(preview[3]).toMatchObject({ subject: "Initech + hiring", signature: "Ada, Acme", shown: { label: "Version A", of: 2 } });
    expect(preview[3].body).toContain("[unsubscribe link]");
    expect(preview[4]).toMatchObject({ body: null, subject: null });
  });

  it("asks for a sender rather than calling the tag a mistake when none is chosen", () => {
    const c = campaign(steps);
    const lee = previewContact(db(), c.ws, contact(c))!;
    const preview = previewSequence(db(), c.ws, lee, { steps }, previewSenders(db(), c.ws, null));
    expect(preview[1].body).toBe("Hi Lee, {{sender.first_name}} here.");
    expect(preview[1].warnings).toEqual(["Choose who this is sent from to fill the sender's details."]);
  });

  it("answers through the route for a viewer, previewing unsaved steps when given them", async () => {
    const c = campaign(steps);
    const lee = contact(c, { email: null });
    const published = await call(previewHandler, { method: "POST", query: { id: c.workflow }, body: { target_id: lee }, headers: as(c, "viewer") });
    expect(published.statusCode).toBe(200);
    expect((published.body.steps as unknown[]).length).toBe(5);
    expect(published.body.contact).toMatchObject({ name: expect.stringContaining("Lee Lead"), company: "Initech" });

    const unsaved = await call(previewHandler, { method: "POST", query: { id: c.workflow }, body: { target_id: lee, steps: [{ step_type: "email", email_subject: "Only this", email_body: "One step" }] }, headers: as(c, "viewer") });
    const only = (unsaved.body.steps as Array<{ subject: string; warnings: string[] }>)[0];
    expect(only.subject).toBe("Only this");
    expect(only.warnings).toContain("This contact has no email address, so the step would be skipped.");

    expect((await call(previewHandler, { method: "POST", query: { id: c.workflow }, body: {}, headers: as(c, "viewer") })).statusCode).toBe(400);
    expect((await call(previewHandler, { method: "POST", query: { id: c.workflow }, body: { target_id: "someone-else" }, headers: as(c, "viewer") })).statusCode).toBe(404);
  });
});

describe("an address in angle brackets", () => {
  it("is kept in an email's text, where markup is stripped", () => {
    expect(toPlainText("Signed, Ada <ada@acme.test>")).toBe("Signed, Ada <ada@acme.test>");
    expect(toPlainText("<p>Hi <b>Lee</b></p><p>Ada <ada@acme.test></p>")).toBe("Hi Lee\n\nAda <ada@acme.test>");
    expect(toPlainText("Not an address: <not an@address.test> or <a href=\"mailto:x@y.test\">this</a>")).toBe("Not an address:  or this");
    expect(buildEmailContent("Reply to {{sender.name}} <ada@acme.test>", { mode: "plain", jobId: "job-1" }).text).toBe("Reply to {{sender.name}} <ada@acme.test>");
  });
});

describe("a test send", () => {
  const step: StepInput = { step_type: "email", email_subject: "{{company}} + hiring", email_body: "Hi {{first_name}}\n\n{{unsubscribe|Opt out}}", email_variants: [{ subject: "B subject", body: "B body" }] };

  it("goes to the person who asked, marked as a test, with no working unsubscribe link", async () => {
    const c = campaign([step]);
    const lee = contact(c);
    const res = await call(testSendHandler, { method: "POST", query: { id: c.workflow }, body: { step, target_id: lee, email_account_id: c.mailbox }, headers: as(c, "member") });
    expect(res.statusCode).toBe(200);
    const own = (db().prepare("SELECT email FROM users WHERE id = ?").get(c.user) as { email: string }).email;
    expect(res.body).toMatchObject({ ok: true, to: own, subject: "[Test] Initech + hiring" });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0].to).toBe(own);
    expect(smtp.sent[0].body).toContain("Hi Lee");
    expect(smtp.sent[0].body).toContain("[unsubscribe link]");
    expect(smtp.sent[0].body).toContain("Ada, Acme");
    // The contact it was written for is not sent anything, and nothing is recorded against the campaign.
    expect(db().prepare("SELECT COUNT(*) AS c FROM step_sends WHERE workflow_id = ?").get(c.workflow)).toEqual({ c: 0 });
  });

  it("sends the version asked for", async () => {
    const c = campaign([step]);
    const res = await call(testSendHandler, { method: "POST", query: { id: c.workflow }, body: { step, target_id: contact(c), email_account_id: c.mailbox, pick: 1 }, headers: as(c, "member") });
    expect(res.body).toMatchObject({ subject: "[Test] B subject" });
  });

  it("lets only an admin send one to another address", async () => {
    const c = campaign([step]);
    const body = { step, target_id: contact(c), email_account_id: c.mailbox, to: "boss@elsewhere.test" };
    const refused = await call(testSendHandler, { method: "POST", query: { id: c.workflow }, body, headers: as(c, "manager") });
    expect(refused.statusCode).toBe(403);
    expect(smtp.sent).toHaveLength(0);
    const allowed = await call(testSendHandler, { method: "POST", query: { id: c.workflow }, body, headers: as(c, "admin") });
    expect(allowed.body).toMatchObject({ ok: true, to: "boss@elsewhere.test" });
  });

  it("refuses what cannot be tested this way", async () => {
    const c = campaign([step]);
    const lee = contact(c);
    const post = (body: Record<string, unknown>, role: "viewer" | "member" = "member") => call(testSendHandler, { method: "POST", query: { id: c.workflow }, body, headers: as(c, role) });
    expect((await post({ step: { step_type: "message", message_body: "Hi" }, target_id: lee, email_account_id: c.mailbox })).body.error).toBe("Only an email step can be sent as a test");
    // A step AI writes can be tested now, but only with something to write from: with no model chosen there is nothing to send.
    expect((await post({ step: { ...step, ai_enabled: 1 }, target_id: lee, email_account_id: c.mailbox })).statusCode).toBe(400);
    expect((await post({ step: { step_type: "email", email_subject: "S", email_body: "" }, target_id: lee, email_account_id: c.mailbox })).body.error).toBe("This step has nothing to send yet.");
    expect((await post({ step, target_id: lee })).body.error).toBe("Choose a mailbox to send the test from");
    expect((await post({ step, target_id: lee, email_account_id: c.mailbox }, "viewer")).statusCode).toBe(403);
    expect(smtp.sent).toHaveLength(0);
  });
});

describe("what the builder is given, and who may publish", () => {
  it("reads the campaign, its sequence, what each step has sent and what a step can refer to", async () => {
    const c = campaign([{ key: "e1", step_type: "email", email_subject: "S", email_body: "B", email_variants: [{ subject: "S2", body: "B2" }] }]);
    createTemplate(db(), c.ws, { name: "T", body: "x" });
    db().prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key) VALUES (?, ?, 'Trigger', 'trigger')").run(`cf-${c.ws}`, c.ws);
    const lee = contact(c);
    await start(c);
    await tick(db(), { pace: false });

    const res = await call(builderHandler, { method: "GET", query: { id: c.workflow }, headers: as(c, "viewer") });
    expect(res.statusCode).toBe(200);
    const data = res.body as unknown as NonNullable<ReturnType<typeof builderData>>;
    expect(data.campaign).toMatchObject({ id: c.workflow, status: "active", enrolled: 1 });
    expect(data.sequence.steps).toHaveLength(1);
    expect(data.figures.steps[c.steps.e1]).toMatchObject({ sent: 1, contacts: 1 });
    expect(data.figures.versions[c.steps.e1].reduce((sum, version) => sum + version.sent, 0)).toBe(1);
    expect(data.templates.map((template) => template.name)).toEqual(["T"]);
    expect(data.custom_fields).toEqual([{ key: "trigger", name: "Trigger" }]);
    expect(data.mailboxes).toEqual([{ id: c.mailbox, name: "Ada Okafor", email: expect.stringContaining("@acme.test") }]);
    expect(data.linkedin_accounts).toEqual([{ id: c.account, name: "Jordan Mertens" }]);
    expect(data.sample_contacts.map((sample) => sample.id)).toEqual([lee]);
    expect(data.draft).toBeNull();
    expect(data.can_publish).toBe(false);

    saveDraft(db(), c.ws, c.workflow, c.user, { steps: [] });
    const withDraft = builderData(db(), c.ws, c.workflow, "manager")!;
    expect(withDraft.draft).toMatchObject({ updated_by_name: "Morgan Member", stale: false, sequence: { steps: [] } });
    expect(builderData(db(), "another-workspace", c.workflow, "owner")).toBeNull();
    expect((await call(builderHandler, { method: "GET", query: { id: "nope" }, headers: as(c, "viewer") })).statusCode).toBe(404);
  });

  it("lets a member publish until contacts are part-way through, and a manager after", async () => {
    expect(canPublish("member", 0)).toBe(true);
    expect(canPublish("member", 3)).toBe(false);
    expect(canPublish("manager", 3)).toBe(true);
    expect(canPublish("viewer", 0)).toBe(false);

    const twoSteps: StepInput[] = [{ key: "e1", step_type: "email", email_subject: "S", email_body: "B" }, { step_type: "delay", track: "email", delay_seconds: DAY }, { key: "e2", step_type: "email", email_subject: "S2", email_body: "B2" }];
    const c = campaign(twoSteps);
    const next = { steps: [{ step_type: "email", email_subject: "Changed", email_body: "Changed" }] };
    expect((await call(publishHandler, { method: "POST", query: { id: c.workflow }, body: next, headers: as(c, "member") })).statusCode).toBe(200);
    expect((await call(publishHandler, { method: "POST", query: { id: c.workflow }, body: next, headers: as(c, "viewer") })).statusCode).toBe(403);

    contact(c);
    await start(c);
    const refused = await call(publishHandler, { method: "POST", query: { id: c.workflow }, body: next, headers: as(c, "member") });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({ required_role: "manager", in_flight: 1 });
    expect(String(refused.body.error)).toContain("1 contact is part-way through");
    expect((await call(publishHandler, { method: "POST", query: { id: c.workflow }, body: next, headers: as(c, "manager") })).statusCode).toBe(200);
  });
});

describe("AI rewrite", () => {
  it("checks what it is asked before spending anything", () => {
    expect(rewriteProblem({ channel: "email", body: "  " })).toBe("There is nothing to rewrite yet: write a first version");
    expect(rewriteProblem({ channel: "sms" as never, body: "Hi" })).toContain("channel must be one of");
    expect(rewriteProblem({ channel: "linkedin", body: "Hi", style: "louder" as never })).toContain("style must be one of");
    expect(rewriteProblem({ channel: "linkedin", body: "Hi", style: "shorter", instruction: "Mention the webinar" })).toBeNull();
  });

  it("tells the model to keep merge tags, and notices when it did not", () => {
    const prompt = buildRewritePrompt({ channel: "connect_note", body: "Hi {{first_name}}", style: "shorter", instruction: "Sound less formal" });
    expect(prompt).toContain("Keep every {{merge_tag}} exactly as written");
    expect(prompt).toContain("300 characters or fewer");
    expect(prompt).toContain("The author also asks: Sound less formal");
    expect(tagChanges("Hi {{first_name}} at {{company}}", "Hi {{ first_name }}, about {{role}}")).toEqual({ missing: ["{{company}}"], added: ["{{role}}"] });
    expect(tagChanges("Hi {{first_name|there}}", "Hello {{first_name|there}}")).toEqual({ missing: [], added: [] });
  });

  it("reads the model's answer, keeping the old subject when none comes back", () => {
    const input = { channel: "email" as const, body: "Old", subject: "Old subject" };
    expect(parseRewrite('```json\n{"subject":"New subject","body":"New body"}\n```', input)).toEqual({ subject: "New subject", body: "New body" });
    expect(parseRewrite('{"body":"New body"}', input)).toEqual({ subject: "Old subject", body: "New body" });
    expect(parseRewrite('{"subject":"Ignored","body":"Shorter"}', { channel: "linkedin", body: "Old" })).toEqual({ subject: null, body: "Shorter" });
    expect(() => parseRewrite("Sure! Here you go", input)).toThrow("did not answer in the expected form");
    expect(() => parseRewrite('{"body":""}', input)).toThrow("returned nothing to use");
  });

  it("says what to set up when the workspace has no key or no model, without calling anything", async () => {
    const c = campaign([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noKey = await call(rewriteHandler, { method: "POST", body: { channel: "linkedin", body: "Hi {{first_name}}" }, headers: as(c, "member") });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.body).toMatchObject({ outcome: "not_set_up", error: "Add an OpenRouter or Google Gemini API key under AI & models to use AI rewrite." });

    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(c.ws, encryptSecret("sk-test"));
    db().prepare("INSERT OR REPLACE INTO workspace_ai_config (workspace_id, default_model) VALUES (?, NULL)").run(c.ws);
    const noModel = await call(rewriteHandler, { method: "POST", body: { channel: "linkedin", body: "Hi {{first_name}}" }, headers: as(c, "member") });
    expect(noModel.body).toMatchObject({ outcome: "not_set_up", error: "Choose a default model under AI & models to use AI rewrite." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await call(rewriteHandler, { method: "POST", body: { channel: "linkedin", body: "Hi" }, headers: as(c, "viewer") })).statusCode).toBe(403);
  });

  it("returns the rewrite with what it cost, and records the use", async () => {
    const c = campaign([]);
    db().prepare("UPDATE workflows SET prompt = 'We sell outbound tooling to revenue teams.' WHERE id = ?").run(c.workflow);
    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(c.ws, encryptSecret("sk-test"));
    db().prepare("INSERT OR REPLACE INTO workspace_ai_config (workspace_id, default_model) VALUES (?, 'acme/writer-1')").run(c.ws);
    const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ subject: "Shorter subject", body: "Hi {{first_name}}, worth a chat?" }) } }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0004 } }),
      sent: init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(rewriteHandler, { method: "POST", body: { channel: "email", subject: "A long subject", body: "Hi {{first_name}}, I wanted to reach out about {{company}}.", style: "shorter", workflow_id: c.workflow }, headers: as(c, "member") });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ subject: "Shorter subject", body: "Hi {{first_name}}, worth a chat?", model: "acme/writer-1", input_tokens: 120, output_tokens: 30, cost_usd: 0.0004, tag_changes: { missing: ["{{company}}"], added: [] } });
    const sent = fetchMock.mock.calls[0][1];
    expect(sent.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(sent.body).model).toBe("acme/writer-1");
    expect(sent.body).toContain("We sell outbound tooling to revenue teams.");
    expect(db().prepare("SELECT model, input_tokens, cost_usd FROM agent_sessions WHERE workspace_id = ?").get(c.ws)).toEqual({ model: "acme/writer-1", input_tokens: 120, cost_usd: 0.0004 });

    // Someone else's campaign cannot lend its context.
    const other = campaign([]);
    expect((await call(rewriteHandler, { method: "POST", body: { channel: "linkedin", body: "Hi", workflow_id: other.workflow }, headers: as(c, "member") })).statusCode).toBe(404);
    // It is counted with the workspace's other AI use, under its own heading.
    expect(db().prepare("SELECT purpose, used_fallback FROM agent_sessions WHERE workspace_id = ?").get(c.ws)).toEqual({ purpose: "rewrite", used_fallback: 0 });
  });

  it("stops when the month's AI budget is used up, and turns to the fallback model when the first cannot answer", async () => {
    const c = campaign([]);
    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(c.ws, encryptSecret("sk-test"));
    db().prepare("INSERT OR REPLACE INTO workspace_ai_config (workspace_id, default_model, fallback_model, monthly_budget_usd) VALUES (?, 'acme/busy', 'acme/spare', 1)").run(c.ws);
    const asked: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      asked.push(model);
      if (model === "acme/busy") return { ok: false, status: 429, json: async () => ({ error: { message: "Rate limited" } }) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ body: "Shorter" }) } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.6 } }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const post = () => call(rewriteHandler, { method: "POST", body: { channel: "linkedin", body: "A longer message" }, headers: as(c, "member") });

    const first = await post();
    expect(first.body).toMatchObject({ body: "Shorter", model: "acme/spare" });
    expect(asked).toEqual(["acme/busy", "acme/spare"]);
    expect(db().prepare("SELECT model, used_fallback FROM agent_sessions WHERE workspace_id = ?").get(c.ws)).toEqual({ model: "acme/spare", used_fallback: 1 });

    // 0.60 spent of a 1.00 budget: one more is allowed, and takes the month over it.
    expect((await post()).statusCode).toBe(200);
    const refused = await post();
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({ outcome: "budget_reached" });
    expect(asked).toHaveLength(4);
  });
});
