// What the campaign wizard says about a campaign as it is being set up.
import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT, STEPS, clearChecks, nameList, nextProblem, railLine, safetyNote, sequenceFacts, stepDone, stepIndex, tokens, usd,
  type Draft, type Prelaunch, type SetupOptions,
} from "@/components/campaigns/wizard/model";
import type { StepInput } from "@/components/sequence/model";

const DAY = 86_400;
const steps: StepInput[] = [
  { step_type: "visit", track: "linkedin" },
  { step_type: "delay", track: "linkedin", delay_seconds: DAY },
  { step_type: "connect", track: "linkedin", connect_note: "Hi {{first_name}}" },
  { step_type: "delay", track: "linkedin", delay_seconds: 3 * DAY },
  { step_type: "message", track: "linkedin", message_body: "Thanks" },
  { step_type: "delay", track: "linkedin", delay_seconds: 6 * DAY },
  { step_type: "message", track: "linkedin", message_body: "Again", ai_enabled: 1 },
  { step_type: "delay", track: "email", delay_seconds: DAY },
  { step_type: "email", track: "email", email_subject: "S", email_body: "B", email_variants: [{ subject: "S2", body: "B2" }, { subject: "S3", body: "B3" }] },
  { step_type: "delay", track: "email", delay_seconds: 3 * DAY },
  { step_type: "email", track: "email", email_subject: "S", email_body: "B" },
];
const options: SetupOptions = {
  lists: [{ id: "l1", name: "Enterprise VP Sales", contacts: 1240, with_email: 1100, verified_email: 1094 }],
  linkedin_accounts: [], mailboxes: [],
};
const draft = (change: Partial<Draft> = {}): Draft => ({ ...EMPTY_DRAFT, ...change, setup: { ...EMPTY_DRAFT.setup, ...(change.setup ?? {}) }, ai: { ...EMPTY_DRAFT.ai, ...(change.ai ?? {}) } });
const check = (key: Prelaunch["checks"][number]["key"], state: "ok" | "warn" | "block", detail = "detail") => ({ key, label: key, state, detail });
const prelaunch = (checks: Prelaunch["checks"], capacity: Partial<Prelaunch["capacity"]> = {}): Prelaunch => ({
  checks, ready: checks.every((entry) => entry.state !== "block"), capacity: { linkedin_accounts: 3, invites_per_day: 54, mailboxes: 4, emails_per_day: 160, warming_up: 0, ...capacity },
} as Prelaunch);

describe("the campaign wizard's wording", () => {
  it("has the design's six steps, in order", () => {
    expect(STEPS.map((step) => step.name)).toEqual(["List picker", "AI context", "LinkedIn steps", "Email steps", "Sender accounts", "Summary"]);
    expect(stepIndex("senders")).toBe(4);
  });

  it("reads a sequence into what each track holds and the day each step falls on", () => {
    const facts = sequenceFacts(steps);
    expect(facts.linkedin).toEqual([
      { type: "visit", label: "Profile visit", day: 1 }, { type: "connect", label: "Connection request + note", day: 2 },
      { type: "message", label: "LinkedIn message", day: 5 }, { type: "message", label: "Follow-up message", day: 11 },
    ]);
    expect(facts.email).toEqual([{ type: "email", label: "Email 1 · 3 A/B versions", day: 2 }, { type: "email", label: "Email 2", day: 5 }]);
    expect(facts).toMatchObject({ versions: 3, aiSteps: 1 });
  });

  it("says in the rail what has been chosen so far", () => {
    const facts = sequenceFacts(steps);
    expect(railLine("list", draft(), options, facts)).toBe("Choose who to reach");
    expect(railLine("list", draft({ setup: { ...EMPTY_DRAFT.setup, list_id: "l1" } }), options, facts)).toBe("Enterprise VP Sales · 1,240");
    expect(railLine("context", draft(), options, facts)).toBe("Optional: brief the AI writer");
    expect(railLine("context", draft({ prompt: "We sell", ai: { angle: "", tone: "Direct", triggers: ["hiring", "funding", "job_change"], model: null } }), options, facts)).toBe("Value prop, tone, 3 trigger sources");
    expect(railLine("context", draft({ ai: { angle: "Gap", tone: "", triggers: ["hiring"], model: null } }), options, facts)).toBe("Angle, 1 trigger source");
    expect(railLine("linkedin", draft(), options, facts)).toBe("4 steps · visit, invite, 2 messages");
    expect(railLine("email", draft(), options, facts)).toBe("2 steps · 3 A/B versions");
    expect(railLine("linkedin", draft(), options, sequenceFacts([]))).toBe("No LinkedIn steps");
    expect(railLine("senders", draft(), options, facts)).toBe("Choose who it is sent from");
    expect(railLine("senders", draft({ setup: { ...EMPTY_DRAFT.setup, account_ids: ["a", "b", "c"], email_account_ids: ["m"] } }), options, facts)).toBe("3 LinkedIn · 1 mailbox");
  });

  it("knows which steps have what they need, which lack it, and which need nothing", () => {
    const both = sequenceFacts(steps);
    const emailOnly = sequenceFacts(steps.filter((step) => step.track === "email"));
    expect(stepDone("list", draft({ name: "Q4" }), both, undefined)).toBe(false);
    expect(stepDone("list", draft({ name: "Q4", setup: { ...EMPTY_DRAFT.setup, list_id: "l1" } }), both, undefined)).toBe(true);
    expect(stepDone("context", draft(), both, undefined)).toBeNull();
    expect(stepDone("linkedin", draft(), emailOnly, undefined)).toBeNull();
    expect(stepDone("email", draft(), emailOnly, undefined)).toBe(true);
    expect(stepDone("linkedin", draft(), sequenceFacts([]), undefined)).toBe(false);
    // An email-only campaign needs a mailbox and no LinkedIn account.
    expect(stepDone("senders", draft({ setup: { ...EMPTY_DRAFT.setup, email_account_ids: ["m"] } }), emailOnly, undefined)).toBe(true);
    expect(stepDone("senders", draft({ setup: { ...EMPTY_DRAFT.setup, email_account_ids: ["m"] } }), both, undefined)).toBe(false);
    expect(stepDone("summary", draft(), both, prelaunch([check("audience", "block")]))).toBe(false);
    expect(stepDone("summary", draft(), both, prelaunch([check("overlap", "warn")]))).toBe(true);
  });

  it("holds the wizard on its first step until the campaign has a name and a list", () => {
    expect(nextProblem("list", draft())).toBe("Give the campaign a name");
    expect(nextProblem("list", draft({ name: "Q4" }))).toBe("Choose the list to run it on");
    expect(nextProblem("list", draft({ name: "Q4", setup: { ...EMPTY_DRAFT.setup, list_id: "l1" } }))).toBeNull();
    expect(nextProblem("senders", draft())).toBeNull();
  });

  it("sums the senders' state up in a sentence", () => {
    expect(safetyNote(undefined)).toBeNull();
    expect(safetyNote(prelaunch([check("linkedin", "ok"), check("mailboxes", "ok")]))).toEqual({ ok: true, title: "Safe sending checks passed", body: "All 7 sender accounts are signed in, verified and under their daily caps." });
    expect(safetyNote(prelaunch([check("linkedin", "ok"), check("mailboxes", "warn", "SPF is not passing for 1 mailbox.")]))).toEqual({ ok: false, title: "Worth a look before launch", body: "SPF is not passing for 1 mailbox." });
    expect(safetyNote(prelaunch([check("linkedin", "block", "Choose a LinkedIn account."), check("mailboxes", "warn")]))?.title).toBe("A sender needs attention");
    expect(clearChecks([check("sequence", "ok"), check("audience", "ok"), check("overlap", "warn"), check("ai", "block")])).toBe(2);
  });

  it("formats names, money and tokens for the review cards", () => {
    expect(nameList(["A", "B"])).toBe("A, B");
    expect(nameList(["A", "B", "C", "D"])).toBe("A, B and 2 more");
    expect(usd(18.6)).toBe("$18.60");
    expect(usd(0.017, 3)).toBe("$0.017");
    expect(usd(0.004)).toBe("$0.004");
    expect(usd(null)).toBe("—");
    expect(tokens(4_200_000)).toBe("4.2M");
    expect(tokens(900_000)).toBe("900k");
    expect(tokens(640)).toBe("640");
    expect(tokens(null)).toBe("—");
  });
});
