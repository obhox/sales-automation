// The contact profile's server side: what the page reads about one contact, each
// campaign's steps and what became of them, the one timeline across both channels, the
// record of joining and leaving lists that the database keeps by itself, previous and
// next through a contacts request, the owner, the notes' author, and the booking link.
// Real (throwaway) database. Nothing here opens a mailbox or a browser.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ctxHeaders } from "./helpers/ctx";
import targetsHandler from "@/pages/api/targets/index";
import targetHandler from "@/pages/api/targets/[id]";
import activityHandler from "@/pages/api/activity-logs";
import bookingHandler from "@/pages/api/platform/booking-link";
import addMembersHandler from "@/pages/api/lists/[id]/add-members";
import listHandler from "@/pages/api/lists/[id]/index";
import { numberSteps, stampOf, type CampaignHistory, type ContactProfile, type TimelineItem } from "@/lib/contacts/profile";

const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface CallOptions { body?: unknown; query?: Record<string, string>; role?: string; user?: string }

function workspace() {
  const n = ++seq;
  const ws = `ws-profile-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const mailbox = `mailbox-${n}`;
  db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'Outbound', ?, 'smtp.invalid', 'user', 'pass')").run(mailbox, ws, `out${n}@example.test`);
  const call = async (handler: Handler, method: string, opts: CallOptions = {}) => {
    const res = mockRes();
    const role = opts.role ?? "member";
    await handler({ method, body: opts.body ?? {}, query: opts.query ?? {}, headers: ctxHeaders(ws, { userId: opts.user ?? `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
  };
  const contact = (name: string, fields: Record<string, unknown> = {}) => {
    const id = `person-${++seq}`;
    insert("targets", { id, workspace_id: ws, full_name: name, linkedin_url: `https://www.linkedin.com/in/${id}/`, created_at: "2026-09-01 08:00:00", ...fields });
    return id;
  };
  const list = (name: string) => {
    const id = `plist-${++seq}`;
    insert("lists", { id, workspace_id: ws, name });
    return id;
  };
  const user = (name: string, role = "member") => {
    const id = `puser-${++seq}`;
    insert("users", { id, email: `${id}@example.test`, name, password_hash: "x" });
    insert("workspace_members", { workspace_id: ws, user_id: id, role });
    return id;
  };
  /**
   * A campaign with steps on each channel, one run, and one contact enrolled in it. Steps
   * are given per channel in order, as [type, waitDaysBefore, subject?].
   */
  const campaign = (name: string, targetId: string, steps: { linkedin?: [string, number][]; email?: [string, number, string?][] }, runStatus = "running", createdAt = "2026-09-20 09:00:00") => {
    const workflowId = `pwf-${++seq}`;
    const runId = `prun-${++seq}`;
    const profileId = `prp-${++seq}`;
    insert("workflows", { id: workflowId, workspace_id: ws, name });
    insert("runs", { id: runId, workspace_id: ws, workflow_id: workflowId, status: runStatus, created_at: createdAt });
    insert("run_profiles", { id: profileId, run_id: runId, target_id: targetId, email_account_id: mailbox, created_at: createdAt });
    const ids: Record<"linkedin" | "email", string[]> = { linkedin: [], email: [] };
    for (const track of ["linkedin", "email"] as const) {
      let order = 0;
      for (const [type, wait, subject] of (steps[track] ?? []) as [string, number, string?][]) {
        if (wait > 0) insert("workflow_steps", { id: `pstep-${++seq}`, workflow_id: workflowId, track, step_type: "delay", step_order: ++order, delay_seconds: wait * 86_400 });
        const id = `pstep-${++seq}`;
        insert("workflow_steps", { id, workflow_id: workflowId, track, step_type: type, step_order: ++order, delay_seconds: 0, email_subject: subject ?? null });
        ids[track].push(id);
      }
    }
    const track = (name: "linkedin" | "email", fields: Record<string, unknown>) => insert("run_profile_tracks", { id: `ptrack-${++seq}`, run_profile_id: profileId, track: name, state: "in_progress", current_step: 0, ...fields });
    const send = (stepId: string, channel: "linkedin" | "email", action: string, sentAt: string, withMail = false) => {
      const job = withMail ? `pjob-${++seq}` : null;
      if (job) {
        insert("email_jobs", { id: job, workspace_id: ws, email_account_id: mailbox, idempotency_key: job, target_id: targetId, run_id: runId, recipient: "x@prospect.test", subject: "Quick question about freight", body_text: "Hello there", status: "sent" });
        insert("sent_messages", { id: `sm-${job}`, workspace_id: ws, job_id: job, email_account_id: mailbox, target_id: targetId, run_id: runId, recipient: "x@prospect.test", subject: "Quick question about freight", message_id: `<${job}@example.test>`, accepted_at: sentAt });
      }
      insert("step_sends", { id: `psend-${++seq}`, workspace_id: ws, run_id: runId, workflow_id: workflowId, step_id: stepId, target_id: targetId, channel, action, sent_at: sentAt, email_job_id: job });
      return job;
    };
    const event = (job: string, type: "opened" | "clicked", at: string, bot = 0) =>
      insert("sender_events", { id: `pev-${++seq}`, workspace_id: ws, email_account_id: mailbox, sent_message_id: `sm-${job}`, provider: "tracking", event_type: type, occurred_at: at, is_bot: bot });
    return { workflowId, runId, ids, track, send, event };
  };
  const profile = async (id: string, opts: CallOptions = {}) => (await call(targetHandler, "GET", { ...opts, query: { id, view: "profile" } })).body as unknown as ContactProfile;
  const timeline = async (id: string, query: Record<string, string> = {}) =>
    (await call(targetHandler, "GET", { query: { id, view: "timeline", ...query } })).body as unknown as { items: TimelineItem[]; total: number; counts: Record<string, number> };
  const membership = (targetId: string) => db().prepare("SELECT list_id, list_name, action, workspace_id FROM list_membership_events WHERE target_id = ? ORDER BY id").all(targetId) as { list_id: string; list_name: string | null; action: string; workspace_id: string | null }[];
  return { ws, mailbox, call, insert, contact, list, user, campaign, profile, timeline, membership };
}

// ─────────────────────────────────────────────────────────────────────
describe("the record of joining and leaving lists", () => {
  it("is written by the database whenever a membership row is, whoever writes it", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran");
    const list = w.list("Enterprise EU");
    // Through a route...
    await w.call(addMembersHandler, "POST", { query: { id: list }, body: { contact_ids: [person] } });
    expect(w.membership(person)).toEqual([{ list_id: list, list_name: "Enterprise EU", action: "added", workspace_id: w.ws }]);
    // ...and adding someone who is already there writes nothing more.
    await w.call(addMembersHandler, "POST", { query: { id: list }, body: { contact_ids: [person] } });
    expect(w.membership(person)).toHaveLength(1);
    // Straight into the table, as an import or a campaign gate does.
    const second = w.list("Freight DACH");
    db().prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(second, person);
    db().prepare("DELETE FROM list_targets WHERE list_id = ? AND target_id = ?").run(list, person);
    expect(w.membership(person).map((event) => `${event.action}:${event.list_name}`)).toEqual(["added:Enterprise EU", "added:Freight DACH", "removed:Enterprise EU"]);
  });

  it("goes with the contact when the contact is deleted, and deleting raises nothing", async () => {
    const w = workspace();
    const person = w.contact("Leaving");
    const stays = w.contact("Staying");
    const list = w.list("Tier 1");
    for (const id of [person, stays]) db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(list, id);
    const res = await w.call(targetsHandler, "DELETE", { body: { target_ids: [person] } });
    expect(res.body).toEqual({ deleted: 1 });
    expect(w.membership(person)).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM list_targets WHERE target_id = ?").get(person)).toEqual({ c: 0 });
    // The other contact's history is untouched.
    expect(w.membership(stays)).toHaveLength(1);
  });

  it("survives its list being deleted, and still knows what the list was called", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran");
    const list = w.list("Webinar Q3");
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(list, person);
    const res = await w.call(listHandler, "DELETE", { query: { id: list } });
    expect(res.statusCode).toBe(204);
    expect(db().prepare("SELECT COUNT(*) AS c FROM list_targets WHERE list_id = ?").get(list)).toEqual({ c: 0 });
    // Whether or not the database reported the row going, the timeline names the list.
    const lines = (await w.timeline(person)).items.filter((item) => item.kind === "list_added" || item.kind === "list_removed");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((item) => item.list?.name === "Webinar Q3")).toBe(true);
  });

  it("is kept per workspace", async () => {
    const mine = workspace();
    const theirs = workspace();
    const theirPerson = theirs.contact("Theirs");
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(theirs.list("Their list"), theirPerson);
    expect((await mine.call(targetHandler, "GET", { query: { id: theirPerson, view: "timeline" } })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the contact as the API has always given it", () => {
  it("keeps its shape without a view", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran", { title: "VP Revenue Ops" });
    const res = await w.call(targetHandler, "GET", { query: { id: person } });
    expect(res.body).toMatchObject({ id: person, full_name: "Marcus Oyelaran", title: "VP Revenue Ops", company: null, lists: [] });
    expect(res.body.contact).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the profile", () => {
  it("is not found for a contact of another workspace", async () => {
    const mine = workspace();
    const theirs = workspace();
    const res = await mine.call(targetHandler, "GET", { query: { id: theirs.contact("Theirs"), view: "profile" } });
    expect(res.statusCode).toBe(404);
  });

  it("gathers the contact, company, lists, tags, custom fields, tasks and the booking link", async () => {
    const w = workspace();
    const owner = w.user("Priya Raghavan");
    w.insert("companies", { id: "co-nw", workspace_id: w.ws, name: "Northwind Logistics", domain: "northwind.example", industry: "Freight", employee_count: 1800, location: "Rotterdam, Netherlands" });
    const person = w.contact("Marcus Oyelaran", {
      title: "VP Revenue Ops", company: "Northwind Logistics", company_id: "co-nw", owner_id: owner, intent_score: 86.2, email: "m@northwind.example", email_status: "verified",
      email_verified_at: "2026-10-02 09:00:00", time_zone: "Europe/Amsterdam", degree: 1, connected_at: "2026-10-04 16:21:00",
      positions_json: JSON.stringify([{ title: "VP Revenue Ops", companyName: "Northwind Logistics", current: true, startDate: "2022-03-01" }, { title: "Director", companyName: "Delta Cargo", startDate: { year: 2018, month: 6 }, endDate: { year: 2022, month: 2 } }, {}]),
    });
    for (const [name, intent] of [["Dana Reyes", 70], ["Pieter Visser", 40], ["Hugo Kern", 90], ["Fourth One", 10]] as const) w.contact(name, { company_id: "co-nw", intent_score: intent });
    for (const name of ["Zebra", "Alpha"]) db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list(name), person);
    w.insert("contact_tags", { id: "ptag-1", workspace_id: w.ws, name: "Champion", color: "good" });
    w.insert("target_tags", { target_id: person, tag_id: "ptag-1" });
    w.insert("custom_field_definitions", { id: "pf-date", workspace_id: w.ws, name: "Renewal date", key: "renewal_date", field_type: "date" });
    w.insert("custom_field_definitions", { id: "pf-seats", workspace_id: w.ws, name: "Seats", key: "seats", field_type: "number" });
    w.insert("contact_custom_values", { workspace_id: w.ws, target_id: person, field_id: "pf-date", value_text: "2026-11-14" });
    w.insert("contact_custom_values", { workspace_id: w.ws, target_id: person, field_id: "pf-seats", value_number: 9 });
    w.insert("todos", { id: "ptodo-done", workspace_id: w.ws, target_id: person, title: "Done already", status: "done", due_date: "2026-10-01" });
    w.insert("todos", { id: "ptodo-later", workspace_id: w.ws, target_id: person, title: "Follow up after RFP", due_date: "2026-11-15" });
    w.insert("todos", { id: "ptodo-soon", workspace_id: w.ws, target_id: person, title: "Send pricing", due_date: "2026-10-09" });
    await w.call(bookingHandler, "PUT", { body: { url: "https://cal.example/acme" }, role: "admin" });

    const profile = await w.profile(person, { role: "viewer" });
    expect(profile.contact).toMatchObject({
      full_name: "Marcus Oyelaran", title: "VP Revenue Ops", intent_score: 86, linkedin_status: "connected", email_status: "verified", email_verified_at: "2026-10-02 09:00:00",
      time_zone: "Europe/Amsterdam", owner: { id: owner, name: "Priya Raghavan" }, tags: [{ id: "ptag-1", name: "Champion", color: "good" }], reply: null, verifying: false,
    });
    expect(profile.contact.positions).toEqual([
      { title: "VP Revenue Ops", company: "Northwind Logistics", start: "2022-03-01", end: null, current: true },
      { title: "Director", company: "Delta Cargo", start: "2018-06-01", end: "2022-02-01", current: false },
    ]);
    expect(profile.company).toMatchObject({ id: "co-nw", name: "Northwind Logistics", industry: "Freight", employee_count: 1800, other_count: 4 });
    // Three of the others, the likeliest to matter first.
    expect(profile.company!.others.map((other) => other.full_name)).toEqual(["Hugo Kern", "Dana Reyes", "Pieter Visser"]);
    expect(profile.lists.map((list) => list.name)).toEqual(["Alpha", "Zebra"]);
    expect(profile.custom.values).toEqual({ "pf-date": "2026-11-14", "pf-seats": 9 });
    expect(profile.custom.fields.map((field) => field.key)).toEqual(["renewal_date", "seats"]);
    // Open tasks first, the soonest due at the top.
    expect(profile.tasks.map((task) => task.title)).toEqual(["Send pricing", "Follow up after RFP", "Done already"]);
    expect(profile.booking_url).toBe("https://cal.example/acme");
  });

  it("never reaches into another workspace for the company", async () => {
    const mine = workspace();
    const theirs = workspace();
    theirs.insert("companies", { id: "co-theirs", workspace_id: theirs.ws, name: "Their company" });
    const person = mine.contact("Mine", { company_id: "co-theirs" });
    expect((await mine.profile(person)).company).toBeNull();
  });

  it("names the latest reply and its verdict, from stored replies or from the contact's own record", async () => {
    const w = workspace();
    const stored = w.contact("Stored", { email_replied_at: "2026-10-05 10:00:00" });
    w.insert("email_replies", { id: "prep-1", workspace_id: w.ws, target_id: stored, from_email: "a@b.test", body_text: "Let's talk", received_at: "2026-10-05T10:00:00.000Z", channel: "email", classification_json: JSON.stringify({ kind: "positive" }) });
    expect((await w.profile(stored)).contact.reply).toEqual({ channel: "email", at: "2026-10-05 10:00:00", verdict: "positive" });

    const marked = w.contact("Marked by hand", { last_replied_at: "2026-10-09T08:00:00.000Z" });
    expect((await w.profile(marked)).contact.reply).toEqual({ channel: "linkedin", at: "2026-10-09 08:00:00", verdict: null });

    // A later LinkedIn reply known only from the record wins over an older stored email, and keeps its verdict.
    const both = w.contact("Both", { last_replied_at: "2026-10-09 08:00:00" });
    w.insert("email_replies", { id: "prep-2", workspace_id: w.ws, target_id: both, from_email: "a@b.test", body_text: "Not now", received_at: "2026-10-01 10:00:00", channel: "email", sentiment: "negative" });
    expect((await w.profile(both)).contact.reply).toEqual({ channel: "linkedin", at: "2026-10-09 08:00:00", verdict: "negative" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("campaign history", () => {
  it("numbers a campaign's steps across both channels in the order they come due", () => {
    const step = (id: string, track: string, type: string, order: number, delay = 0) => ({ id, track, step_type: type, step_order: order, delay_seconds: delay, email_subject: null, enabled: 1 });
    const numbered = numberSteps([
      step("visit", "linkedin", "visit", 1), step("d1", "linkedin", "delay", 2, 86_400), step("connect", "linkedin", "connect", 3),
      step("d2", "linkedin", "delay", 4, 4 * 86_400), step("message", "linkedin", "message", 5),
      step("d3", "email", "delay", 1, 86_400), step("email-1", "email", "email", 2), step("d4", "email", "delay", 3, 2 * 86_400), step("email-2", "email", "email", 4),
    ]);
    // Day 0 visit; day 1 invite then email (LinkedIn first on a tie); day 3 email; day 5 message.
    expect(numbered.map((entry) => [entry.number, entry.step.id])).toEqual([[1, "visit"], [2, "connect"], [3, "email-1"], [4, "email-2"], [5, "message"]]);
    // A step's index counts the waits before it on its own channel, as a contact's progress does.
    expect(Object.fromEntries(numbered.map((entry) => [entry.step.id, entry.index]))).toEqual({ visit: 0, connect: 2, message: 4, "email-1": 1, "email-2": 3 });
  });

  it("says what became of each step for a contact part-way through", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran", { connected_at: "2026-10-04 16:21:00", degree: 1 });
    const c = w.campaign("Q4 Logistics Ops", person, { linkedin: [["connect", 0], ["message", 3]], email: [["email", 1, "Intro"], ["email", 4, "Value"]] });
    c.send(c.ids.linkedin[0], "linkedin", "connect", "2026-10-02 10:05:00");
    const job = c.send(c.ids.email[0], "email", "email", "2026-10-03 08:30:00", true)!;
    c.event(job, "opened", "2026-10-03 09:00:00");
    c.event(job, "opened", "2026-10-03 11:00:00");
    c.event(job, "opened", "2026-10-03 08:30:02", 1); // a mail scanner
    c.event(job, "clicked", "2026-10-03 11:01:00");
    // LinkedIn: invite sent, standing on the wait before the message. Email: first sent, waiting for the second.
    c.track("linkedin", { current_step: 1, next_step_at: "2026-10-12T09:00:00.000Z" });
    c.track("email", { current_step: 2, next_step_at: "2026-10-11 09:00:00" });

    const [history] = (await w.profile(person)).campaigns as CampaignHistory[];
    expect(history).toMatchObject({ name: "Q4 Logistics Ops", state: "active", steps_total: 4, steps_sent: 2, next_number: 3, stop_reason: null, last_touch_at: "2026-10-03 08:30:00" });
    expect(history.steps.map((step) => [step.number, step.track, step.type, step.status, step.at])).toEqual([
      [1, "linkedin", "connect", "sent", "2026-10-02 10:05:00"],
      [2, "email", "email", "sent", "2026-10-03 08:30:00"],
      [3, "linkedin", "message", "next", "2026-10-12 09:00:00"],
      [4, "email", "email", "next", "2026-10-11 09:00:00"],
    ]);
    expect(history.steps[0].accepted_at).toBe("2026-10-04 16:21:00");
    expect(history.steps[1]).toMatchObject({ subject: "Intro", email: { opens: 2, clicks: 1, bounced: false } });
  });

  it("shows a campaign stopped by a reply, one that failed, one that finished and one that is paused", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran", { last_replied_at: "2026-10-05 10:00:00" });

    const stopped = w.campaign("Stopped by reply", person, { linkedin: [["connect", 0], ["message", 3], ["message", 5]] }, "running", "2026-09-04 09:00:00");
    stopped.send(stopped.ids.linkedin[0], "linkedin", "connect", "2026-10-02 10:05:00");
    stopped.track("linkedin", { state: "skipped", current_step: 2, error_message: "Replied on linkedin - automation stopped" });

    const failed = w.campaign("Failed", person, { email: [["email", 0, "One"], ["email", 2, "Two"]] }, "running", "2026-09-03 09:00:00");
    failed.track("email", { state: "failed", current_step: 0, error_message: "Mailbox rejected the message" });

    const finished = w.campaign("Finished", person, { email: [["email", 0, "One"], ["email", 2, "Two"]] }, "completed", "2026-09-02 09:00:00");
    finished.send(finished.ids.email[0], "email", "email", "2026-09-02 10:00:00");
    finished.send(finished.ids.email[1], "email", "email", "2026-09-04 10:00:00");
    finished.track("email", { state: "completed", current_step: 3 });

    const paused = w.campaign("Paused", person, { email: [["email", 0, "One"]] }, "paused", "2026-09-01 09:00:00");
    paused.track("email", { state: "pending", current_step: 0 });

    const byName = Object.fromEntries((await w.profile(person)).campaigns.map((campaign) => [campaign.name, campaign]));
    expect(byName["Stopped by reply"]).toMatchObject({ state: "stopped", stop_reason: "Replied on linkedin - automation stopped", next_number: null, replied: true });
    expect(byName["Stopped by reply"].steps.map((step) => step.status)).toEqual(["sent", "stopped", "stopped"]);
    expect(byName["Stopped by reply"].steps[1].reason).toBe("Replied on linkedin - automation stopped");
    expect(byName.Failed).toMatchObject({ state: "failed", stop_reason: "Mailbox rejected the message" });
    expect(byName.Failed.steps.map((step) => [step.status, step.reason])).toEqual([["failed", "Mailbox rejected the message"], ["stopped", null]]);
    expect(byName.Finished).toMatchObject({ state: "completed", steps_sent: 2, steps_total: 2, last_touch_at: "2026-09-04 10:00:00" });
    expect(byName.Paused).toMatchObject({ state: "paused", next_number: 1 });
    // The campaigns still going come first.
    expect((await w.profile(person)).campaigns.map((campaign) => campaign.name).slice(-1)).toEqual(["Finished"]);
  });

  it("marks a switched-off step and a channel waiting for a hand-over", async () => {
    const w = workspace();
    const person = w.contact("Marcus Oyelaran");
    const c = w.campaign("Hand-over", person, { linkedin: [["visit", 0], ["connect", 1]], email: [["email", 0, "After LinkedIn"]] });
    db().prepare("UPDATE workflow_steps SET enabled = 0 WHERE id = ?").run(c.ids.linkedin[0]);
    c.track("linkedin", { current_step: 1 });
    c.track("email", { state: "pending", current_step: 0, hold: "handover" });
    const [history] = (await w.profile(person)).campaigns;
    expect(history.steps.find((step) => step.type === "visit")).toMatchObject({ status: "skipped", reason: "This step is switched off" });
    expect(history.steps.find((step) => step.type === "email")).toMatchObject({ status: "next", reason: "Starts when the LinkedIn steps hand this contact over" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the timeline", () => {
  async function busyContact() {
    const w = workspace();
    const teammate = w.user("Jonas Mertens");
    const person = w.contact("Marcus Oyelaran", { connected_at: "2026-10-04 16:21:00", connection_requested_at: "2026-10-02 10:05:00", apollo_enriched_at: "2026-09-28 18:05:00", created_at: "2026-09-28 18:00:00" });
    const c = w.campaign("Q4 Logistics Ops", person, { linkedin: [["connect", 0], ["message", 3]], email: [["email", 1, "Intro"]] });
    c.send(c.ids.linkedin[0], "linkedin", "connect", "2026-10-02 10:05:00");
    const job = c.send(c.ids.email[0], "email", "email", "2026-10-03T08:30:00.000Z", true)!;
    c.event(job, "opened", "2026-10-06 09:00:00");
    c.event(job, "opened", "2026-10-07 11:38:00");
    c.event(job, "clicked", "2026-10-07 11:30:00");
    c.event(job, "opened", "2026-10-08 01:00:00", 1);
    c.send(c.ids.linkedin[1], "linkedin", "message", "2026-10-07 09:12:00");
    w.insert("linkedin_messages", { id: `plm-campaign-${++seq}`, workspace_id: w.ws, target_id: person, direction: "out", body: "Thanks for connecting, Marcus.", sent_at: "2026-10-07T09:12:40.000Z", status: "delivered" });
    w.insert("linkedin_messages", { id: `plm-hand-${++seq}`, workspace_id: w.ws, target_id: person, direction: "out", body: "Sending the deck now.", sent_at: "2026-10-09 15:00:00", status: "queued", created_by: teammate });
    w.insert("email_replies", { id: `prep-tl-${++seq}`, workspace_id: w.ws, target_id: person, from_email: "", body_text: "Makes sense, we're mid-RFP but I'd take a look.", received_at: "2026-10-10T14:04:00.000Z", channel: "linkedin", classification_json: JSON.stringify({ kind: "positive" }) });
    await w.call(activityHandler, "POST", { body: { target_id: person, type: "note", body: "Referred by Dana Reyes.", logged_at: "2026-10-02 09:40:00" }, user: teammate });
    w.insert("meetings", { id: `pmeet-1-${++seq}`, workspace_id: w.ws, target_id: person, title: "Intro call", starts_at: "2026-10-12 10:00:00" });
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list("Enterprise EU"), person);
    db().prepare("UPDATE list_membership_events SET created_at = '2026-09-28 18:02:00' WHERE target_id = ?").run(person);
    return { w, person, teammate, campaign: c };
  }

  it("puts everything that happened on one line of time, newest first", async () => {
    const { w, person, campaign } = await busyContact();
    const { items, total, counts } = await w.timeline(person);
    expect(items.map((item) => [item.kind, item.at])).toEqual([
      ["meeting", "2026-10-12 10:00:00"],
      ["reply", "2026-10-10 14:04:00"],
      ["linkedin_message", "2026-10-09 15:00:00"],
      ["email_engaged", "2026-10-07 11:38:00"],
      ["linkedin_message", "2026-10-07 09:12:00"],
      ["linkedin_accepted", "2026-10-04 16:21:00"],
      ["email_sent", "2026-10-03 08:30:00"],
      ["linkedin_invite", "2026-10-02 10:05:00"],
      ["activity", "2026-10-02 09:40:00"],
      ["enriched", "2026-09-28 18:05:00"],
      ["list_added", "2026-09-28 18:02:00"],
      ["created", "2026-09-28 18:00:00"],
    ]);
    expect(total).toBe(12);
    expect(counts).toEqual({ all: 12, email: 2, linkedin: 5 });

    const by = (kind: string, index = 0) => items.filter((item) => item.kind === kind)[index];
    // A campaign's step carries its number and the campaign.
    expect(by("email_sent")).toMatchObject({ step: 2, campaign: { id: campaign.workflowId, name: "Q4 Logistics Ops" }, detail: "Quick question about freight", channel: "email" });
    expect(by("linkedin_invite")).toMatchObject({ step: 1, campaign: { name: "Q4 Logistics Ops" } });
    // Opens and clicks are one line for the email, without the mail scanner's open.
    expect(by("email_engaged")).toMatchObject({ opens: 2, clicks: 1, detail: "Quick question about freight" });
    // The campaign's message shows what it said; the one sent by hand says who sent it and that it is waiting.
    expect(by("linkedin_message", 1)).toMatchObject({ step: 3, actor: null, detail: "Thanks for connecting, Marcus." });
    expect(by("linkedin_message", 0)).toMatchObject({ step: null, actor: "Jonas Mertens", label: "queued", detail: "Sending the deck now." });
    expect(by("reply")).toMatchObject({ channel: "linkedin", label: "positive", detail: "Makes sense, we're mid-RFP but I'd take a look." });
    expect(by("activity")).toMatchObject({ label: "note", actor: "Jonas Mertens", detail: "Referred by Dana Reyes." });
    expect(by("activity").activity_id).toEqual(expect.any(String));
    expect(by("list_added").list).toMatchObject({ name: "Enterprise EU" });
  });

  it("can be narrowed to one channel and read a page at a time", async () => {
    const { w, person } = await busyContact();
    expect((await w.timeline(person, { channel: "email" })).items.map((item) => item.kind)).toEqual(["email_engaged", "email_sent"]);
    const linkedin = await w.timeline(person, { channel: "linkedin" });
    expect(linkedin.items.every((item) => item.channel === "linkedin")).toBe(true);
    expect(linkedin.total).toBe(5);
    // The counts are of everything, whichever channel is showing.
    expect(linkedin.counts).toEqual({ all: 12, email: 2, linkedin: 5 });
    const page = await w.timeline(person, { limit: "3", offset: "3" });
    expect(page.items.map((item) => item.kind)).toEqual(["email_engaged", "linkedin_message", "linkedin_accepted"]);
    expect(page.total).toBe(12);
    expect((await w.timeline(person, { channel: "carrier-pigeon" })).total).toBe(12);
  });

  it("shows a reply known only from the contact's record, and an invitation sent outside a campaign", async () => {
    const w = workspace();
    const person = w.contact("By hand", { connection_requested_at: "2026-10-01 10:00:00", invite_withdrawn_at: "2026-10-20 10:00:00", last_replied_at: "2026-10-05T10:00:00.000Z", email_replied_at: "2026-10-06 10:00:00" });
    const kinds = (await w.timeline(person)).items.map((item) => `${item.kind}:${item.channel}`);
    expect(kinds).toEqual(["linkedin_withdrawn:linkedin", "reply:email", "reply:linkedin", "linkedin_invite:linkedin", "created:other"]);
  });

  it("includes emails sent by hand and LinkedIn messages in both directions, with their full text", async () => {
    const w = workspace();
    const person = w.contact("Both ways");
    const long = `${"Long body. ".repeat(40)}The end.`;
    w.insert("email_jobs", { id: `pjob-${++seq}`, workspace_id: w.ws, email_account_id: w.mailbox, idempotency_key: `k-${seq}`, source: "contact_thread", target_id: person, recipient: "x@example.com", subject: "Following up", body_text: long, status: "sent", updated_at: "2026-10-05 09:00:00" });
    w.insert("linkedin_messages", { id: `plm-in-${++seq}`, workspace_id: w.ws, target_id: person, direction: "in", body: "Sure, send it over.", sent_at: "2026-10-06T10:00:00.000Z", message_urn: "urn:in:1" });
    w.insert("linkedin_messages", { id: `plm-native-${++seq}`, workspace_id: w.ws, target_id: person, direction: "out", body: "Typed on LinkedIn itself.", sent_at: "2026-10-06T11:00:00.000Z", message_urn: "urn:out:1" });
    const { items } = await w.timeline(person);
    const mail = items.find((item) => item.kind === "email_sent")!;
    expect(mail).toMatchObject({ subject: "Following up", body: long, channel: "email" });
    expect(items.find((item) => item.kind === "linkedin_received")).toMatchObject({ detail: "Sure, send it over.", body: "Sure, send it over." });
    expect(items.some((item) => item.kind === "linkedin_message" && item.body === "Typed on LinkedIn itself.")).toBe(true);
  });

  it("reports a bounce", async () => {
    const w = workspace();
    const person = w.contact("Bounced");
    const c = w.campaign("Push", person, { email: [["email", 0, "Hello"]] });
    const job = c.send(c.ids.email[0], "email", "email", "2026-10-03 08:30:00", true)!;
    db().prepare("UPDATE sent_messages SET bounced_at = '2026-10-03 08:31:00', status = 'bounced' WHERE job_id = ?").run(job);
    expect((await w.timeline(person)).items.map((item) => item.kind)).toEqual(["email_bounced", "email_sent", "created"]);
    expect((await w.profile(person)).campaigns[0].steps[0].email).toMatchObject({ bounced: true });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("previous and next", () => {
  const neighbours = async (w: ReturnType<typeof workspace>, id: string, query: Record<string, string> = {}) =>
    (await w.call(targetsHandler, "GET", { query: { view: "neighbours", id, ...query }, role: "viewer" })).body.neighbours as { position: number; total: number; previous: string | null; next: string | null } | null;

  it("follow the order and the filters the table was showing", async () => {
    const w = workspace();
    const low = w.contact("Low", { intent_score: 10, country: "Spain" });
    const mid = w.contact("Mid", { intent_score: 50, country: "Spain" });
    const high = w.contact("High", { intent_score: 90, country: "Spain" });
    const away = w.contact("Away", { intent_score: 70, country: "Norway" });

    // The table's own order: intent, highest first.
    expect(await neighbours(w, mid)).toEqual({ position: 3, total: 4, previous: away, next: low });
    expect(await neighbours(w, high)).toEqual({ position: 1, total: 4, previous: null, next: away });
    // With a filter, the contact outside it is stepped over.
    expect(await neighbours(w, mid, { country: "Spain" })).toEqual({ position: 2, total: 3, previous: high, next: low });
    // With another sort.
    expect(await neighbours(w, mid, { sort: "name:asc" })).toEqual({ position: 4, total: 4, previous: low, next: null });
    // A contact the filters no longer select has no place in the list.
    expect(await neighbours(w, away, { country: "Spain" })).toBeNull();
  });

  it("stay inside the workspace", async () => {
    const mine = workspace();
    const theirs = workspace();
    mine.contact("Mine");
    expect(await neighbours(mine, theirs.contact("Theirs"))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("editing a contact from the profile", () => {
  const row = (id: string) => db().prepare("SELECT owner_id, notes, notes_updated_at, notes_updated_by, title FROM targets WHERE id = ?").get(id) as Record<string, string | null>;

  it("gives the contact to a member of the workspace, or to nobody", async () => {
    const w = workspace();
    const outsider = workspace().user("Outsider");
    const priya = w.user("Priya");
    const person = w.contact("Marcus");
    expect((await w.call(targetHandler, "PATCH", { query: { id: person }, body: { owner_id: priya } })).statusCode).toBe(200);
    expect(row(person).owner_id).toBe(priya);
    expect((await w.call(targetHandler, "PATCH", { query: { id: person }, body: { owner_id: outsider } })).statusCode).toBe(400);
    expect(row(person).owner_id).toBe(priya);
    await w.call(targetHandler, "PATCH", { query: { id: person }, body: { owner_id: null } });
    expect(row(person).owner_id).toBeNull();
    expect((await w.call(targetHandler, "PATCH", { query: { id: person }, body: { owner_id: priya }, role: "viewer" })).statusCode).toBe(403);
  });

  it("records who last changed the notes, and only when they changed", async () => {
    const w = workspace();
    const author = w.user("Jonas Mertens");
    const person = w.contact("Marcus");
    await w.call(targetHandler, "PATCH", { query: { id: person }, body: { notes: "Mid-RFP. Re-engage after Nov 14." }, user: author });
    const first = row(person);
    expect(first).toMatchObject({ notes: "Mid-RFP. Re-engage after Nov 14.", notes_updated_by: author });
    expect(first.notes_updated_at).not.toBeNull();
    expect((await w.profile(person)).contact.notes_updated_by).toEqual({ id: author, name: "Jonas Mertens" });

    // Saving the same words again (an autosave with nothing new) leaves the record alone, as does editing another field.
    db().prepare("UPDATE targets SET notes_updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(person);
    await w.call(targetHandler, "PATCH", { query: { id: person }, body: { notes: "  Mid-RFP. Re-engage after Nov 14.  " } });
    await w.call(targetHandler, "PATCH", { query: { id: person }, body: { title: "CRO" } });
    expect(row(person)).toMatchObject({ notes_updated_at: "2026-01-01 00:00:00", notes_updated_by: author, title: "CRO" });

    // Clearing them counts as a change.
    await w.call(targetHandler, "PATCH", { query: { id: person }, body: { notes: "" } });
    expect(row(person).notes).toBeNull();
    expect(row(person).notes_updated_at).not.toBe("2026-01-01 00:00:00");
  });

  it("records who logged an activity", async () => {
    const w = workspace();
    const author = w.user("Jonas Mertens");
    const person = w.contact("Marcus");
    const res = await w.call(activityHandler, "POST", { body: { target_id: person, type: "call", body: "Spoke for ten minutes." }, user: author });
    expect(res.statusCode).toBe(201);
    expect(res.body.created_by).toBe(author);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the booking link", () => {
  it("is read by anyone in the workspace and set by an admin", async () => {
    const w = workspace();
    expect((await w.call(bookingHandler, "GET", { role: "viewer" })).body).toEqual({ url: null });
    expect((await w.call(bookingHandler, "PUT", { body: { url: "https://cal.example/acme" }, role: "manager" })).statusCode).toBe(403);
    expect((await w.call(bookingHandler, "PUT", { body: { url: "  https://cal.example/acme  " }, role: "admin" })).body).toEqual({ url: "https://cal.example/acme" });
    expect((await w.call(bookingHandler, "GET", { role: "viewer" })).body).toEqual({ url: "https://cal.example/acme" });
    // Another workspace has its own.
    expect((await workspace().call(bookingHandler, "GET")).body).toEqual({ url: null });
  });

  it("has to be an ordinary web address, and an empty value takes it away", async () => {
    const w = workspace();
    const put = (url: unknown) => w.call(bookingHandler, "PUT", { body: { url }, role: "admin" });
    for (const bad of ["cal.example/acme", "javascript:alert(1)", "mailto:me@example.test", 42, `https://cal.example/${"a".repeat(600)}`]) expect((await put(bad)).statusCode).toBe(400);
    await put("https://cal.example/acme");
    expect((await put("")).body).toEqual({ url: null });
    expect((await w.call(bookingHandler, "GET")).body).toEqual({ url: null });
  });
});

describe("times", () => {
  it("are read the same whichever way they were written", () => {
    expect(stampOf("2026-10-10T14:02:11.000Z")).toBe("2026-10-10 14:02:11");
    expect(stampOf("2026-10-10 14:02:11")).toBe("2026-10-10 14:02:11");
    expect(stampOf("2026-10-10T16:02:11+02:00")).toBe("2026-10-10 14:02:11");
    expect(stampOf("2026-10-10")).toBe("2026-10-10 00:00:00");
    expect(stampOf("not a time")).toBeNull();
    expect(stampOf(null)).toBeNull();
  });
});
