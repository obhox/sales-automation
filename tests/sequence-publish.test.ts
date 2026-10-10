// The one writer of a campaign's sequence: steps that keep their ids, contacts that keep
// their place, gates, drafts and publishing, and copying a campaign. Real (throwaway)
// database, no runner.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { copySequence, gatesOf, loadSequence, publishSequence, sequenceProblem, sequenceSettings, type StepInput } from "@/lib/outreach/publish";
import stepsHandler from "@/pages/api/workflows/[id]/steps";
import stepHandler from "@/pages/api/workflows/[id]/steps/[stepId]";
import sequenceHandler from "@/pages/api/workflows/[id]/sequence";
import draftHandler from "@/pages/api/workflows/[id]/draft";
import publishHandler from "@/pages/api/workflows/[id]/publish";
import duplicateHandler from "@/pages/api/workflows/[id]/duplicate";
import branchesHandler from "@/pages/api/platform/workflow-branches";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with an empty campaign, and headers to call routes as its manager. */
function campaign() {
  const n = ++seq;
  const ws = `ws-seq-${n}`;
  const workflow = `seq-wf-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO workflows (id, name, workspace_id, prompt, send_in_recipient_tz) VALUES (?, 'Campaign', ?, 'Be brief.', 1)").run(workflow, ws);
  return { ws, workflow, headers: ctxHeaders(ws, { userId: `seq-manager-${n}`, role: "manager" }), member: ctxHeaders(ws, { userId: `seq-member-${n}`, role: "member" }) };
}

const message = (body: string): StepInput => ({ step_type: "message", message_body: body });
const email = (subject: string, extra: Partial<StepInput> = {}): StepInput => ({ step_type: "email", email_subject: subject, email_body: `Body of ${subject}`, ...extra });

type Row = { id: string; track: string; step_order: number; step_type: string; message_body: string | null; email_subject: string | null };
const stepsOf = (workflow: string, track = "linkedin") =>
  db().prepare("SELECT id, track, step_order, step_type, message_body, email_subject FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order").all(workflow, track) as Row[];

/** Put a contact part-way through a run of the campaign, standing at `index` on a track. */
function standing(c: { ws: string; workflow: string }, index: number, track = "linkedin", state = "in_progress") {
  const k = ++seq;
  const run = `seq-run-${k}`;
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'Lead', ?)").run(`seq-target-${k}`, c.ws, `https://www.linkedin.com/in/seq-${k}/`);
  db().prepare("INSERT INTO runs (id, workspace_id, workflow_id, status) VALUES (?, ?, ?, 'running')").run(run, c.ws, c.workflow);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`seq-rp-${k}`, run, `seq-target-${k}`);
  db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, ?, ?)").run(`seq-rt-${k}`, `seq-rp-${k}`, track, state, index);
  return () => (db().prepare("SELECT current_step FROM run_profile_tracks WHERE id = ?").get(`seq-rt-${k}`) as { current_step: number }).current_step;
}

// ─────────────────────────────────────────────────────────────────────
describe("saving a sequence without ids, as the old editor does", () => {
  it("matches steps by position and moves nobody, exactly as before", () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, b, c3] = stepsOf(c.workflow).map((step) => step.id);
    const at = standing(c, 1);

    // The first step is deleted. By position, every later step takes its predecessor's id.
    const result = publishSequence(db(), c.workflow, [message("B"), message("C")]);

    expect(result.by_id).toBe(false);
    expect(stepsOf(c.workflow).map((step) => [step.id, step.message_body])).toEqual([[a, "B"], [b, "C"]]);
    expect(result.deleted).toEqual([c3]);
    expect(result.moved).toBe(0);
    expect(at()).toBe(1);
  });

  it("still takes the old editor's request through the route", async () => {
    const c = campaign();
    const res = await call(stepsHandler, { method: "PUT", query: { id: c.workflow }, body: { steps: [{ step_type: "visit" }, { step_type: "email", email_subject: "Hi", email_body: "Hello", email_variants: [{ subject: "Hey", body: "Hello" }] }] }, headers: c.member });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, by_id: false, in_flight: 0 });
    expect(stepsOf(c.workflow).map((step) => step.step_type)).toEqual(["visit"]);
    expect(stepsOf(c.workflow, "email").map((step) => step.email_subject)).toEqual(["Hi"]);
    const listed = await call(stepsHandler, { method: "GET", query: { id: c.workflow }, headers: c.member });
    const emailStep = (listed.body as unknown as Array<{ step_type: string; email_variants: Array<{ subject: string; weight: number | null }> }>).find((step) => step.step_type === "email")!;
    expect(emailStep.email_variants).toMatchObject([{ subject: "Hey", weight: null }]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("saving a sequence by id", () => {
  it("keeps each step's id wherever it moves", () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, b, c3] = stepsOf(c.workflow);

    const result = publishSequence(db(), c.workflow, [{ ...message("C"), id: c3.id }, { ...message("A2"), id: a.id }, message("New"), { ...message("B"), id: b.id }]);

    expect(result.by_id).toBe(true);
    const after = stepsOf(c.workflow);
    expect(after.map((step) => step.message_body)).toEqual(["C", "A2", "New", "B"]);
    expect(after.map((step) => step.id)).toEqual([c3.id, a.id, result.created[0], b.id]);
    expect(result.updated.sort()).toEqual([a.id, b.id, c3.id].sort());
    expect(result.deleted).toEqual([]);
  });

  it("puts every contact part-way through back on the step they were on", () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, b, c3] = stepsOf(c.workflow);
    const onA = standing(c, 0);
    const onB = standing(c, 1);
    const onC = standing(c, 2);
    const finished = standing(c, 3);
    const notStarted = standing(c, 0, "linkedin", "pending");

    // A new step goes in front, and B and C swap.
    const result = publishSequence(db(), c.workflow, [message("New"), { ...message("A"), id: a.id }, { ...message("C"), id: c3.id }, { ...message("B"), id: b.id }]);

    expect([onA(), onB(), onC()]).toEqual([1, 3, 2]);
    // Past the last step stays past the last step; someone who has not started begins at the new first step.
    expect(finished()).toBe(4);
    expect(notStarted()).toBe(0);
    // Four were part-way through; three of them stand somewhere new (C's place did not change).
    expect(result.in_flight).toBe(4);
    expect(result.moved).toBe(3);
  });

  it("sends a contact whose step was removed on to the next step that is left", () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C"), message("D")]);
    const [a, , , d] = stepsOf(c.workflow);
    const onB = standing(c, 1);
    const onC = standing(c, 2);
    const onD = standing(c, 3);

    publishSequence(db(), c.workflow, [{ ...message("A"), id: a.id }, { ...message("D"), id: d.id }]);
    expect([onB(), onC(), onD()]).toEqual([1, 1, 1]);

    // With nothing left after them, they are past the end and finish on their next pass.
    publishSequence(db(), c.workflow, [{ ...message("A"), id: a.id }]);
    expect([onB(), onC(), onD()]).toEqual([1, 1, 1]);
    expect(stepsOf(c.workflow)).toHaveLength(1);
  });

  it("gives a new id to a step claiming another campaign's id, or another track's", () => {
    const c = campaign();
    const other = campaign();
    publishSequence(db(), other.workflow, [message("Theirs")]);
    publishSequence(db(), c.workflow, [message("Mine"), email("Hello")]);
    const theirs = stepsOf(other.workflow)[0].id;
    const mine = stepsOf(c.workflow)[0].id;
    const mail = stepsOf(c.workflow, "email")[0].id;

    const result = publishSequence(db(), c.workflow, [{ ...message("Mine"), id: mine }, { ...message("Stolen"), id: theirs }, { ...message("Was an email"), id: mail }]);

    const after = stepsOf(c.workflow);
    expect(after[0].id).toBe(mine);
    expect(after[1].id).not.toBe(theirs);
    expect(after[2].id).not.toBe(mail);
    expect(result.deleted).toEqual([mail]);
    expect(stepsOf(other.workflow)[0]).toMatchObject({ id: theirs, message_body: "Theirs" });
  });

  it("keeps a version's id, stores its weight, and drops the ones taken out", () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [email("Intro", { email_variants: [{ subject: "B", body: "b" }, { subject: "C", body: "c" }] })]);
    const step = stepsOf(c.workflow, "email")[0].id;
    const variants = () => db().prepare("SELECT id, subject, weight, position FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position").all(step) as Array<{ id: string; subject: string; weight: number | null; position: number }>;
    const [b, cVariant] = variants();

    publishSequence(db(), c.workflow, [email("Intro", { id: step, email_control_weight: 50, email_variants: [{ id: cVariant.id, subject: "C2", body: "c", weight: 30 }, { subject: "D", body: "d", weight: 20 }] })]);

    const after = variants();
    expect(after.map((variant) => [variant.subject, variant.weight])).toEqual([["C2", 30], ["D", 20]]);
    expect(after[0].id).toBe(cVariant.id);
    expect(after.map((variant) => variant.id)).not.toContain(b.id);
    expect(db().prepare("SELECT email_control_weight FROM workflow_steps WHERE id = ?").get(step)).toEqual({ email_control_weight: 50 });
  });

  it("refuses steps it could not run", () => {
    expect(sequenceProblem("nope")).toMatch(/array/);
    expect(sequenceProblem([{ step_type: "carrier_pigeon" }])).toMatch(/step_type/);
    expect(sequenceProblem([{ step_type: "email", track: "linkedin" }])).toMatch(/email track/);
    expect(sequenceProblem([{ step_type: "visit", delay_seconds: -5 }])).toMatch(/negative/);
    expect(sequenceProblem([{ step_type: "visit", window_start: 9 }])).toMatch(/both a start and an end/);
    expect(sequenceProblem([{ step_type: "visit", window_start: 18, window_end: 9 }])).toMatch(/earlier hour/);
    expect(sequenceProblem([{ step_type: "visit", window_start: 9, window_end: 17, window_days: "1,8" }])).toMatch(/window_days/);
    expect(sequenceProblem([{ step_type: "email", email_variants: [{ weight: 0 }] }])).toMatch(/weight/);
    expect(sequenceProblem([{ step_type: "visit", window_start: 9, window_end: 17, window_days: "1,2,3" }, { step_type: "email", email_control_weight: 60, email_variants: [{ weight: 40 }] }])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("gates", () => {
  const post = (c: ReturnType<typeof campaign>, body: Record<string, unknown>, headers = c.headers) => call(branchesHandler, { method: "POST", body: { workflow_id: c.workflow, ...body }, headers });
  const conditions = { mode: "all", conditions: [{ field: "title", operator: "contains", value: "VP" }] };

  it("still saves a branch on conditions the way it always was sent", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, , c3] = stepsOf(c.workflow);

    const created = await post(c, { source_step_id: a.id, conditions, true_step_id: c3.id });
    expect(created.statusCode).toBe(201);
    expect(db().prepare("SELECT kind, true_step_id, false_step_id FROM workflow_branches WHERE id = ?").get(created.body.id)).toEqual({ kind: "conditions", true_step_id: c3.id, false_step_id: null });
    expect(gatesOf(db(), c.workflow)).toMatchObject([{ kind: "conditions", on_true: { then: "jump", step: c3.id }, on_false: { then: "continue" } }]);

    // Saving again on the same step replaces it and answers with the same id.
    const again = await post(c, { source_step_id: a.id, conditions });
    expect(again.statusCode).toBe(200);
    expect(again.body.id).toBe(created.body.id);
    expect(gatesOf(db(), c.workflow)).toMatchObject([{ on_true: { then: "continue" } }]);

    expect((await post(c, { source_step_id: a.id, conditions, true_step_id: a.id })).body.error).toMatch(/later steps/);
    expect((await post(c, { source_step_id: a.id, conditions: { conditions: [] } })).statusCode).toBe(400);
    expect((await post(c, { source_step_id: "nope", conditions })).statusCode).toBe(404);
    expect((await post(c, { source_step_id: a.id, conditions }, c.member)).statusCode).toBe(403);
  });

  it("saves the other kinds with an outcome for each side, where each belongs", async () => {
    const c = campaign();
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Needs an email')").run(`${c.workflow}-list`, c.ws);
    publishSequence(db(), c.workflow, [{ step_type: "connect" }, message("Thanks"), email("Intro")]);
    const [connect, thanks] = stepsOf(c.workflow);
    const intro = stepsOf(c.workflow, "email")[0];

    expect((await post(c, { source_step_id: connect.id, kind: "connected", on_false: { then: "handover_email" } })).statusCode).toBe(201);
    expect((await post(c, { source_step_id: thanks.id, kind: "no_reply", on_false: { then: "leave", effects: [{ type: "create_task", title: "Reply to {{first_name}}" }] } })).statusCode).toBe(201);
    expect((await post(c, { source_step_id: intro.id, kind: "verified_email", on_false: { then: "end_track", effects: [{ type: "add_to_list", list_id: `${c.workflow}-list` }] } })).statusCode).toBe(201);

    const gates = Object.fromEntries(gatesOf(db(), c.workflow).map((gate) => [gate.kind, gate]));
    expect(gates.connected).toMatchObject({ source_step_id: connect.id, on_true: { then: "continue" }, on_false: { then: "handover_email" } });
    expect(gates.no_reply.on_false).toEqual({ then: "leave", step: null, effects: [{ type: "create_task", title: "Reply to {{first_name}}" }] });
    expect(gates.verified_email.on_false.effects).toEqual([{ type: "add_to_list", list_id: `${c.workflow}-list` }]);

    // Each kind where it makes sense, and nowhere else.
    expect((await post(c, { source_step_id: thanks.id, kind: "connected" })).body.error).toMatch(/connection request step/);
    expect((await post(c, { source_step_id: thanks.id, kind: "verified_email" })).body.error).toMatch(/email step/);
    expect((await post(c, { source_step_id: intro.id, kind: "verified_email", on_false: { then: "handover_email" } })).body.error).toMatch(/Only the LinkedIn track/);
    expect((await post(c, { source_step_id: connect.id, kind: "connected", on_false: { then: "jump" } })).body.error).toMatch(/needs the step/);
    expect((await post(c, { source_step_id: connect.id, kind: "connected", on_false: { then: "jump", step: intro.id } })).body.error).toMatch(/later steps/);
    expect((await post(c, { source_step_id: connect.id, kind: "connected", on_false: { then: "vanish" } })).statusCode).toBe(400);
    expect((await post(c, { source_step_id: connect.id, kind: "connected", on_false: { then: "leave", effects: [{ type: "add_to_list", list_id: "someone-elses" }] } })).body.error).toMatch(/not in this workspace/);
    expect((await post(c, { source_step_id: connect.id, kind: "riddle" })).statusCode).toBe(400);
    // A reply always takes the contact out; that gate can only add to it.
    expect((await post(c, { source_step_id: thanks.id, kind: "no_reply", on_false: { then: "continue" } })).body.error).toMatch(/always leaves the campaign/);
  });

  it("stay with their step when the sequence is reordered by id, and go when it is removed", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, b, c3] = stepsOf(c.workflow);
    await post(c, { source_step_id: a.id, conditions, true_step_id: c3.id });

    publishSequence(db(), c.workflow, [{ ...message("B"), id: b.id }, { ...message("A"), id: a.id }, { ...message("C"), id: c3.id }]);
    expect(gatesOf(db(), c.workflow)).toMatchObject([{ source_step_id: a.id, on_true: { then: "jump", step: c3.id } }]);

    // The step it jumps to goes: the gate stays and simply carries on in order.
    publishSequence(db(), c.workflow, [{ ...message("B"), id: b.id }, { ...message("A"), id: a.id }]);
    expect(gatesOf(db(), c.workflow)).toMatchObject([{ source_step_id: a.id, on_true: { then: "continue", step: null } }]);

    publishSequence(db(), c.workflow, [{ ...message("B"), id: b.id }]);
    expect(gatesOf(db(), c.workflow)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("drafting and publishing", () => {
  const put = (c: ReturnType<typeof campaign>, body: unknown, headers = c.member) => call(draftHandler, { method: "PUT", query: { id: c.workflow }, body: body as NextApiRequest["body"], headers });
  const get = (c: ReturnType<typeof campaign>) => call(draftHandler, { method: "GET", query: { id: c.workflow }, headers: c.member });
  const publish = (c: ReturnType<typeof campaign>, body: unknown = {}, headers = c.headers) => call(publishHandler, { method: "POST", query: { id: c.workflow }, body: body as NextApiRequest["body"], headers });

  it("keeps a draft apart from the sequence that is running", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A")]);
    const published = stepsOf(c.workflow)[0];

    const before = await get(c);
    expect(before.body).toMatchObject({ has_draft: false, stale: false });
    expect((before.body.draft as { steps: StepInput[] }).steps).toMatchObject([{ id: published.id, message_body: "A" }]);

    const saved = await put(c, { steps: [{ ...message("A, reworded"), id: published.id }, { step_type: "message" }] });
    expect(saved.statusCode).toBe(200);
    // An unfinished draft is fine to keep; what runs has not changed.
    expect(stepsOf(c.workflow)).toMatchObject([{ id: published.id, message_body: "A" }]);
    const after = await get(c);
    expect(after.body).toMatchObject({ has_draft: true, stale: false });
    expect((after.body.draft as { steps: StepInput[] }).steps).toHaveLength(2);

    expect((await call(draftHandler, { method: "DELETE", query: { id: c.workflow }, headers: c.member })).body).toEqual({ ok: true, discarded: true });
    expect((await get(c)).body.has_draft).toBe(false);
    expect((await put(c, { steps: "all of them" })).statusCode).toBe(400);
  });

  it("publishes the draft: steps by id, gates on new steps by key, settings, and the draft is gone", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [{ step_type: "connect" }, message("Old follow-up")]);
    const [connect, followUp] = stepsOf(c.workflow);
    const onFollowUp = standing(c, 1);

    await put(c, {
      steps: [{ step_type: "visit", key: "look" }, { step_type: "connect", id: connect.id }, { ...message("Thanks for connecting"), key: "thanks" }, { ...message("Follow-up"), id: followUp.id }, email("Intro", { key: "intro" })],
      gates: [
        { source: connect.id, kind: "connected", on_false: { then: "handover_email" } },
        { source: "thanks", kind: "conditions", conditions: { conditions: [{ field: "title", operator: "contains", value: "VP" }] }, on_true: { then: "jump", step: followUp.id } },
        { source: "intro", kind: "verified_email", on_false: { then: "end_track" } },
      ],
      settings: { email_start: "handover" },
    });
    const res = await publish(c);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, by_id: true, gates: 3, in_flight: 1, moved: 1, version: 2 });
    const after = stepsOf(c.workflow);
    expect(after.map((step) => step.step_type)).toEqual(["visit", "connect", "message", "message"]);
    expect([after[1].id, after[3].id]).toEqual([connect.id, followUp.id]);
    expect(onFollowUp()).toBe(3);
    const gates = Object.fromEntries(gatesOf(db(), c.workflow).map((gate) => [gate.kind, gate]));
    expect(gates.conditions).toMatchObject({ source_step_id: after[2].id, on_true: { then: "jump", step: followUp.id } });
    expect(gates.verified_email.source_step_id).toBe(stepsOf(c.workflow, "email")[0].id);
    expect(sequenceSettings(db(), c.workflow)).toEqual({ email_start: "handover", linkedin_track_enabled: true, email_track_enabled: true });
    expect((await get(c)).body.has_draft).toBe(false);

    // A gate left out of the next publish is removed.
    const again = await publish(c, { steps: loadSequence(db(), c.workflow).steps, gates: [] });
    expect(again.body).toMatchObject({ gates: 0, moved: 0 });
    expect(gatesOf(db(), c.workflow)).toEqual([]);
  });

  it("will not publish a draft over a sequence that changed since the draft was started, unless told to", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A")]);
    const a = stepsOf(c.workflow)[0];
    await put(c, { steps: [{ ...message("A, drafted"), id: a.id }] });
    // Someone else publishes in the meantime.
    publishSequence(db(), c.workflow, [{ ...message("A, by someone else"), id: a.id }]);

    expect((await get(c)).body).toMatchObject({ has_draft: true, stale: true });
    const refused = await publish(c);
    expect(refused.statusCode).toBe(409);
    expect(stepsOf(c.workflow)[0].message_body).toBe("A, by someone else");

    expect((await publish(c, { force: true })).statusCode).toBe(200);
    expect(stepsOf(c.workflow)[0]).toMatchObject({ id: a.id, message_body: "A, drafted" });
  });

  it("refuses to publish what could not run, and is not for viewers", async () => {
    const c = campaign();
    expect((await publish(c)).body.error).toMatch(/no draft/);
    expect((await publish(c, { steps: [{ step_type: "smoke_signal" }] })).statusCode).toBe(400);
    expect((await publish(c, { steps: [message("A")], gates: [{ source: "nowhere", kind: "no_reply" }] })).body.error).toMatch(/Source step not found/);
    expect((await publish(c, { steps: [{ ...message("A"), key: "x" }, { ...message("B"), key: "x" }] })).body.error).toMatch(/share the key/);
    expect((await publish(c, { steps: [{ ...message("A"), key: "x" }], gates: [{ source: "x", kind: "no_reply" }, { source: "x", kind: "no_reply" }] })).body.error).toMatch(/only one gate/);
    expect((await publish(c, { steps: [message("A")], settings: { email_start: "whenever" } })).statusCode).toBe(400);
    expect((await publish(c, { steps: [message("A")] }, ctxHeaders(c.ws, { userId: "publish-viewer", role: "viewer" }))).statusCode).toBe(403);
    expect(stepsOf(c.workflow)).toEqual([]);
    // Nobody is part-way through, so a member may publish. (With contacts in flight it takes a manager: see sequence-builder.test.ts.)
    expect((await publish(c, { steps: [message("A")] }, c.member)).statusCode).toBe(200);
  });

  it("replacing every step gives none of the new ones an old id, and finishes whoever was part-way", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B")]);
    const old = stepsOf(c.workflow).map((step) => step.id);
    const onB = standing(c, 1);

    const res = await publish(c, { steps: [message("X"), message("Y"), message("Z")] });

    const fresh = stepsOf(c.workflow).map((step) => step.id);
    expect(fresh).toHaveLength(3);
    expect(fresh.some((id) => old.includes(id))).toBe(false);
    expect((res.body.deleted as string[]).sort()).toEqual([...old].sort());
    // Their step is gone and nothing that followed it is left: past the end.
    expect(onB()).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("copying a campaign", () => {
  it("takes the prompt, the versions, the gates and the settings, with ids of their own", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [{ step_type: "connect" }, message("Thanks"), email("Intro", { email_control_weight: 70, window_start: 9, window_end: 12, email_variants: [{ subject: "Alt", body: "alt", weight: 30 }] })]);
    const [connect, thanks] = stepsOf(c.workflow);
    await call(branchesHandler, { method: "POST", body: { workflow_id: c.workflow, source_step_id: connect.id, kind: "connected", on_true: { then: "jump", step: thanks.id }, on_false: { then: "handover_email" } }, headers: c.headers });
    db().prepare("UPDATE workflows SET email_start = 'handover', email_track_enabled = 0 WHERE id = ?").run(c.workflow);
    db().prepare("UPDATE workflow_step_email_variants SET disabled_at = datetime('now') WHERE step_id IN (SELECT id FROM workflow_steps WHERE workflow_id = ?)").run(c.workflow);

    const res = await call(duplicateHandler, { method: "POST", query: { id: c.workflow }, headers: c.member });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ steps: 3, gates: 1 });
    const copy = String(res.body.id);
    expect(db().prepare("SELECT name, prompt, send_in_recipient_tz FROM workflows WHERE id = ?").get(copy)).toEqual({ name: "Campaign (copy)", prompt: "Be brief.", send_in_recipient_tz: 1 });
    const copied = loadSequence(db(), copy);
    const original = new Set(loadSequence(db(), c.workflow).steps.map((step) => step.id));
    expect(copied.steps.map((step) => step.step_type)).toEqual(["connect", "message", "email"]);
    expect(copied.steps.some((step) => original.has(step.id))).toBe(false);
    expect(copied.steps[2]).toMatchObject({ email_control_weight: 70, window_start: 9, window_end: 12 });
    expect(copied.steps[2].email_variants).toMatchObject([{ subject: "Alt", weight: 30 }]);
    // A version paused in the original starts sending again in the copy: it has no results yet.
    expect(db().prepare("SELECT COUNT(*) AS c FROM workflow_step_email_variants WHERE step_id = ? AND disabled_at IS NOT NULL").get(copied.steps[2].id)).toEqual({ c: 0 });
    // The gate points at the copy's own steps.
    expect(copied.gates).toMatchObject([{ source: copied.steps[0].id, kind: "connected", on_true: { then: "jump", step: copied.steps[1].id }, on_false: { then: "handover_email" } }]);
    expect(copied.settings).toEqual({ email_start: "handover", linkedin_track_enabled: true, email_track_enabled: false });
    // The original is untouched.
    expect(stepsOf(c.workflow).map((step) => step.id)).toEqual([connect.id, thanks.id]);
  });

  it("copies an empty campaign into an empty campaign", () => {
    const c = campaign();
    const target = campaign();
    expect(copySequence(db(), c.ws, c.workflow, target.workflow)).toMatchObject({ steps: [], gates: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("changing one step", () => {
  const one = (c: ReturnType<typeof campaign>, method: string, stepId: string, body: Record<string, unknown> = {}) =>
    call(stepHandler, { method, query: { id: c.workflow, stepId }, body, headers: c.member });

  it("deleting it closes the gap and keeps everyone on their own step", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C")]);
    const [a, b, c3] = stepsOf(c.workflow);
    const onB = standing(c, 1);
    const onC = standing(c, 2);

    const res = await one(c, "DELETE", a.id);

    expect(res.body).toMatchObject({ ok: true, in_flight: 2, moved: 2 });
    expect(stepsOf(c.workflow).map((step) => [step.id, step.step_order])).toEqual([[b.id, 1], [c3.id, 2]]);
    // They were about to do B and C, and still are.
    expect([onB(), onC()]).toEqual([0, 1]);
  });

  it("moving it renumbers its track and keeps everyone on their own step", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), message("C"), email("Intro")]);
    const [a, b, c3] = stepsOf(c.workflow);
    const mail = stepsOf(c.workflow, "email")[0];
    const onB = standing(c, 1);

    const res = await one(c, "PUT", c3.id, { step_order: 1, message_body: "C, first now" });

    expect(res.body).toMatchObject({ ok: true, moved: 1 });
    expect(stepsOf(c.workflow).map((step) => [step.id, step.message_body])).toEqual([[c3.id, "C, first now"], [a.id, "A"], [b.id, "B"]]);
    expect(stepsOf(c.workflow, "email")).toMatchObject([{ id: mail.id, step_order: 1 }]);
    expect(onB()).toBe(2);
  });

  it("takes a window and a weight, checked like any step, and leaves the rest of the step alone", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [email("Intro")]);
    const step = stepsOf(c.workflow, "email")[0];
    expect((await one(c, "PUT", step.id, { window_start: 9, window_end: 12, window_days: "1,2,3", email_control_weight: 60 })).statusCode).toBe(200);
    expect(db().prepare("SELECT window_start, window_end, window_days, email_control_weight, email_subject FROM workflow_steps WHERE id = ?").get(step.id))
      .toEqual({ window_start: 9, window_end: 12, window_days: "1,2,3", email_control_weight: 60, email_subject: "Intro" });
    expect((await one(c, "PUT", step.id, { window_end: 8 })).body.error).toMatch(/earlier hour/);
    expect((await one(c, "PUT", step.id, { email_control_weight: 500 })).statusCode).toBe(400);
    expect((await one(c, "PUT", "no-such-step", { delay_seconds: 5 })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the sequence as it stands", () => {
  const get = (c: ReturnType<typeof campaign>, headers = c.member) => call(sequenceHandler, { method: "GET", query: { id: c.workflow }, headers });

  it("says who is standing where, each gate's two counts, and whether a draft is waiting", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A"), message("B"), email("Intro")]);
    const [a, b] = stepsOf(c.workflow);
    const mail = stepsOf(c.workflow, "email")[0];
    standing(c, 0); standing(c, 1); standing(c, 1); standing(c, 0, "email"); standing(c, 0, "linkedin", "pending");
    await call(branchesHandler, { method: "POST", body: { workflow_id: c.workflow, source_step_id: a.id, kind: "no_reply" }, headers: c.headers });
    const side = (target: string, value: string) =>
      db().prepare("INSERT INTO step_outcomes (id, workspace_id, workflow_id, run_id, target_id, step_id, kind, side, outcome) SELECT ?, ?, ?, id, ?, ?, 'no_reply', ?, 'continue' FROM runs WHERE workflow_id = ? LIMIT 1")
        .run(`seq-outcome-${++seq}`, c.ws, c.workflow, target, a.id, value, c.workflow);
    side("t1", "true"); side("t2", "true"); side("t3", "false");

    const res = await get(c);

    expect(res.body).toMatchObject({
      version: 1, in_flight: 4,
      standing: { [a.id]: 1, [b.id]: 2, [mail.id]: 1 },
      gate_counts: { [a.id]: { true: 2, false: 1 } },
      settings: { email_start: "enrolment", linkedin_track_enabled: true, email_track_enabled: true },
      draft: null,
    });
    expect((res.body.steps as StepInput[]).map((step) => step.id)).toEqual([a.id, b.id, mail.id]);
    expect(res.body.gates).toMatchObject([{ source: a.id, kind: "no_reply" }]);

    await call(draftHandler, { method: "PUT", query: { id: c.workflow }, body: { steps: [] }, headers: c.member });
    expect((await get(c)).body.draft).toMatchObject({ stale: false });
  });

  it("switches a track off or changes when email starts without republishing, for a manager", async () => {
    const c = campaign();
    publishSequence(db(), c.workflow, [message("A")]);
    const patch = (body: unknown, headers = c.headers) => call(sequenceHandler, { method: "PATCH", query: { id: c.workflow }, body: body as NextApiRequest["body"], headers });

    const res = await patch({ email_track_enabled: false, email_start: "handover" });
    expect(res.body).toMatchObject({ version: 1, settings: { email_start: "handover", linkedin_track_enabled: true, email_track_enabled: false } });
    expect((await patch({ email_start: "sometime" })).statusCode).toBe(400);
    expect((await patch({ linkedin_track_enabled: "no" })).statusCode).toBe(400);
    expect((await patch({ linkedin_track_enabled: false }, c.member)).statusCode).toBe(403);
    expect(sequenceSettings(db(), c.workflow)).toEqual({ email_start: "handover", linkedin_track_enabled: true, email_track_enabled: false });
  });
});
