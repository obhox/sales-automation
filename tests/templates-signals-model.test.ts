// What the Templates and Signals screens say: the wording worked out from what the routes
// return, and the cost shown on screen held against the server's own sum.
import { describe, expect, it } from "vitest";
import {
  NO_CATEGORY, categoryOptions, channelCounts, copyName, deleteWarning, figureCells, formProblem, librarySummary, matches, payloadOf, previewLine, replyRate, sortTemplates, usedIn,
  type LibraryTemplate, type TemplateFigures,
} from "@/components/templates/model";
import {
  aboutHint, aboutLine, accountLine, costLines, detectionState, feedSummary, pageLine, previewEstimate, readCap, ruleProblem, rulePayload, ruleState, ruleThen, ruleWhen, rulesSummary, runCost, runLine,
  signalPayload, signalProblem, sourceLabel, spentLine, typeLabel, typeOptions, blankRule, blankSignal, type DetectionEstimate, type Rule,
} from "@/components/signals/model";
import { getDb } from "@/lib/db";
import { DETECTION_KINDS, INTERVAL_DAYS, estimate, watchCompanies, type DetectionConfig } from "@/lib/signals/detection";

const figures = (over: Partial<TemplateFigures> = {}): TemplateFigures => ({ sent: 0, contacts: 0, replied: 0, positive: 0, steps: 0, campaigns: 0, last_sent_at: null, ...over });
const template = (over: Partial<LibraryTemplate> = {}): LibraryTemplate => ({ id: "t1", name: "Intro", body: "Hi {{first_name}},\n\nworth a call?", channel: "linkedin", subject: null, category: null, created_at: "2026-10-01 10:00:00", figures: null, ...over });

describe("the template library", () => {
  it("sums itself up, and offers the categories in use", () => {
    expect(librarySummary({ templates: [], categories: [] })).toBe("No templates yet");
    expect(librarySummary({ templates: [template()], categories: [] })).toBe("1 template");
    const library = { templates: [template({ category: "Openers" }), template({ id: "t2", channel: "email" }), template({ id: "t3", category: "Follow-ups" })], categories: ["Follow-ups", "Openers"] };
    expect(librarySummary(library)).toBe("3 templates · 2 categories");
    expect(categoryOptions(library).map((option) => option.label)).toEqual(["All categories", "Follow-ups", "Openers", "No category"]);
    // With no categories at all there is nothing to tell apart.
    expect(categoryOptions({ templates: [template()], categories: [] })).toEqual([{ value: "all", label: "All categories" }]);
    expect(channelCounts(library.templates)).toEqual({ all: 3, linkedin: 2, email: 1 });
  });

  it("filters by channel, category and text, and sorts", () => {
    const a = template({ id: "a", name: "Break-up", category: "Follow-ups", figures: figures({ sent: 40, contacts: 40, replied: 2 }) });
    const b = template({ id: "b", name: "alpha intro", channel: "email", subject: "Quick question", category: "Openers", figures: figures({ sent: 10, contacts: 10, replied: 3 }) });
    const c = template({ id: "c", name: "Cold", body: "About your funding round" });
    expect([a, b, c].filter((t) => matches(t, { channel: "email", category: "all", q: "" })).map((t) => t.id)).toEqual(["b"]);
    expect([a, b, c].filter((t) => matches(t, { channel: "all", category: "Follow-ups", q: "" })).map((t) => t.id)).toEqual(["a"]);
    expect([a, b, c].filter((t) => matches(t, { channel: "all", category: NO_CATEGORY, q: "" })).map((t) => t.id)).toEqual(["c"]);
    expect([a, b, c].filter((t) => matches(t, { channel: "all", category: "all", q: " FUNDING " })).map((t) => t.id)).toEqual(["c"]);
    expect([a, b, c].filter((t) => matches(t, { channel: "all", category: "all", q: "quick" })).map((t) => t.id)).toEqual(["b"]);
    expect(sortTemplates([a, b, c], "name").map((t) => t.id)).toEqual(["b", "a", "c"]);
    expect(sortTemplates([a, b, c], "most_sent").map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(sortTemplates([a, b, c], "best_reply").map((t) => t.id)).toEqual(["b", "a", "c"]);
    expect(sortTemplates([a, b, c], "newest").map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("shows how a template has done, and says when the numbers are too few to mean much", () => {
    expect(replyRate(null)).toBeNull();
    expect(replyRate(figures({ sent: 50, contacts: 40, replied: 4 }))).toBe(0.1);
    expect(figureCells(null)).toEqual({ sent: "—", replies: "—", positive: "—", thin: false });
    expect(figureCells(figures({ steps: 2 }))).toEqual({ sent: "—", replies: "—", positive: "—", thin: false });
    expect(figureCells(figures({ sent: 1284, contacts: 1200, replied: 132, positive: 41 }))).toEqual({ sent: "1,284", replies: "132 · 11.0%", positive: "41", thin: false });
    expect(figureCells(figures({ sent: 8, contacts: 8, replied: 2, positive: 0 }))).toEqual({ sent: "8", replies: "2 · 25.0%", positive: "0", thin: true });
    expect(figureCells(figures({ sent: 30, contacts: 30 }))).toMatchObject({ replies: "0", positive: "—" });
    expect(usedIn(null)).toBe("Not in a step");
    expect(usedIn(figures({ steps: 1, campaigns: 1 }))).toBe("1 step");
    expect(usedIn(figures({ steps: 3, campaigns: 2 }))).toBe("3 steps in 2 campaigns");
    expect(previewLine(template({ subject: "A quick question", body: "Hi" }))).toBe("A quick question");
    expect(previewLine(template())).toBe("Hi {{first_name}}, worth a call?");
    expect(previewLine(template({ body: "x".repeat(200) })).length).toBe(96);
  });

  it("says what deleting one touches", () => {
    expect(deleteWarning(template())).toBe("This cannot be undone.");
    expect(deleteWarning(template({ figures: figures({ steps: 1, campaigns: 1 }) }))).toMatch(/^One step offers this template\. It will stop offering it/);
    const used = deleteWarning(template({ figures: figures({ steps: 3, campaigns: 2, sent: 120 }) }));
    expect(used).toMatch(/^3 steps offer this template, across 2 campaigns\. They will stop offering it/);
    expect(used).toMatch(/It has been sent 120 times: those messages stay sent/);
  });

  it("checks a template before it is saved, and names a copy", () => {
    expect(formProblem({ name: " ", channel: "linkedin", category: "", subject: "", body: "Hi" })).toMatchObject({ field: "name" });
    expect(formProblem({ name: "Intro", channel: "linkedin", category: "", subject: "", body: "  " })).toMatchObject({ field: "body" });
    expect(formProblem({ name: "Intro", channel: "email", category: "", subject: "", body: "Hi" })).toMatchObject({ field: "subject" });
    expect(formProblem({ name: "Intro", channel: "linkedin", category: "", subject: "", body: "Hi" })).toBeNull();
    // A LinkedIn message has no subject, whatever was typed while it was an email.
    expect(payloadOf({ name: " Intro ", channel: "linkedin", category: " Openers ", subject: "Left over", body: "Hi\n" })).toEqual({ name: "Intro", channel: "linkedin", category: "Openers", subject: "", body: "Hi\n" });
    expect(copyName("Intro", ["Intro"])).toBe("Intro (copy)");
    expect(copyName("Intro (copy)", ["Intro", "intro (COPY)"])).toBe("Intro (copy 2)");
  });
});

describe("the signal feed's wording", () => {
  it("names kinds and sources, and sums the feed up", () => {
    expect(typeLabel("job_change")).toBe("Job change");
    expect(typeLabel("something_else")).toBe("something_else");
    expect(sourceLabel("apollo")).toBe("Apollo detection");
    expect(sourceLabel("manual")).toBe("Recorded by hand");
    expect(sourceLabel("zapier")).toBe("zapier");
    expect(sourceLabel(null)).toBe("Unknown");
    expect(feedSummary({ new_count: 0, all_count: 0 })).toBe("No signals yet");
    expect(feedSummary({ new_count: 3, all_count: 128 })).toBe("3 new · 128 in all");
    expect(feedSummary({ new_count: 0, all_count: 128 })).toBe("128 in all");
    expect(typeOptions({ by_type: { funding: 2, hiring: 1 } }, "technology").map((option) => option.label)).toEqual(["All kinds · 3", "Funding · 2", "Hiring · 1", "Technology · 0"]);
    expect(aboutLine({ contact: { id: "c", name: "Dana Okoye" }, company: { id: "x", name: "Globex" } })).toBe("Dana Okoye · Globex");
    expect(aboutLine({ contact: null, company: null })).toBe("Nobody named");
    expect(pageLine({ total: 128 }, 50, 50)).toBe("51 to 100 of 128");
  });

  it("checks a signal recorded by hand, and says what recording it does", () => {
    expect(signalProblem(blankSignal())).toMatchObject({ field: "title" });
    expect(signalProblem({ ...blankSignal(), title: "Raised a round", score: "140" })).toMatchObject({ field: "score" });
    expect(signalProblem({ ...blankSignal(), title: "Raised a round" })).toMatchObject({ field: "about" });
    const aboutCompany = { ...blankSignal(), type: "funding" as const, title: " Raised a round ", score: "70", about: { kind: "company" as const, id: "co-1", name: "Globex" } };
    expect(signalProblem(aboutCompany)).toBeNull();
    expect(signalPayload(aboutCompany)).toEqual({ type: "funding", title: "Raised a round", description: undefined, score: 70, source: "manual", company_id: "co-1" });
    expect(signalPayload({ ...aboutCompany, about: { kind: "contact", id: "t-1", name: "Dana" } })).toMatchObject({ target_id: "t-1" });
    expect(aboutHint(aboutCompany)).toMatch(/none will fire/);
    expect(aboutHint(blankSignal())).toMatch(/sets off any rule it matches/);
  });
});

describe("a rule's wording", () => {
  const rule = (over: Partial<Rule> = {}): Rule => ({
    id: "r1", name: "Funding → Enterprise", signal_type: "funding", min_score: 50, list_id: "l1", workflow_id: null, account_id: null, email_account_id: null, enabled: 1, auto_start: 0,
    list_name: "Enterprise", workflow_name: null, account_name: null, email_account_name: null, problem: null, ...over,
  });

  it("says when it fires and what it does", () => {
    expect(ruleWhen(rule())).toBe("A funding signal scoring 50 or more");
    expect(ruleWhen(rule({ signal_type: "job_change", min_score: 0 }))).toBe("Any job change signal");
    expect(ruleThen(rule())).toBe("Add to Enterprise");
    expect(ruleThen(rule({ workflow_id: "w1", workflow_name: "Q4 outreach", account_name: "Jordan", email_account_name: "Outbound", auto_start: 1 }))).toBe("Add to Enterprise, then enrol in Q4 outreach from Jordan and Outbound · starts by itself");
    expect(ruleThen(rule({ workflow_id: "w1", workflow_name: null, list_name: null }))).toBe("Add to a list since deleted, then enrol in a campaign since deleted · waits to be started");
    expect(ruleThen(rule({ list_id: null }))).toBe("Nothing");
    expect(ruleState(rule())).toEqual({ label: "On", tone: "good" });
    expect(ruleState(rule({ problem: "The list is gone" }))).toEqual({ label: "Cannot run", tone: "bad" });
    expect(ruleState(rule({ enabled: 0, problem: "The list is gone" }))).toEqual({ label: "Off", tone: "neutral" });
    expect(rulesSummary([])).toBe("No rules yet");
    expect(rulesSummary([rule(), rule({ id: "r2", enabled: 0 }), rule({ id: "r3", problem: "x" })])).toBe("1 of 3 rules on");
  });

  it("checks a rule before it is sent, and clears what a rule without a campaign cannot use", () => {
    expect(ruleProblem(blankRule())).toMatchObject({ field: "name" });
    expect(ruleProblem({ ...blankRule(), name: "Rule", min_score: "200" })).toMatchObject({ field: "min_score" });
    expect(ruleProblem({ ...blankRule(), name: "Rule" })).toMatchObject({ field: "list_id", message: expect.stringMatching(/neither does nothing/) });
    expect(ruleProblem({ ...blankRule(), name: "Rule", workflow_id: "w1" })).toMatchObject({ field: "list_id", message: expect.stringMatching(/needs a list as well/) });
    expect(ruleProblem({ ...blankRule(), name: "Rule", list_id: "l1" })).toBeNull();
    expect(rulePayload({ ...blankRule(), name: " Rule ", list_id: "l1", account_id: "a1", auto_start: true })).toEqual({
      name: "Rule", signal_type: "funding", min_score: 0, list_id: "l1", workflow_id: null, account_id: null, email_account_id: null, auto_start: false,
    });
    expect(rulePayload({ ...blankRule(), name: "Rule", list_id: "l1", workflow_id: "w1", account_id: "a1", auto_start: true })).toMatchObject({ workflow_id: "w1", account_id: "a1", email_account_id: null, auto_start: true });
  });
});

describe("what detection is said to cost", () => {
  const base = (over: Partial<DetectionEstimate> = {}): DetectionEstimate => ({
    accounts: 44, checkable: 42, credits_per_account: 2, credits_per_run: 84, runs_per_month: 5, credits_per_month: 420, cap: 400, spent_this_month: 33, remaining: 367, fits: false, ...over,
  });

  it("is put in sentences before anything is spent", () => {
    expect(costLines(base({ accounts: 0, checkable: 0 }), 7)).toEqual(["No accounts are watched yet, so a run would ask nothing and cost nothing."]);
    expect(costLines(base(), 7)).toEqual([
      "A run looks up 42 accounts at 2 credits each: up to 84 credits. 2 have no website and are skipped.",
      "Every week, that is up to 420 credits a month.",
      "That is more than the cap of 400 credits: a run stops when the cap is reached, and the accounts it did not reach are checked first next time.",
    ]);
    expect(costLines(base({ accounts: 1, checkable: 1, credits_per_account: 1, credits_per_run: 1, credits_per_month: 1, runs_per_month: 1, cap: 50, fits: true }), 30)).toEqual([
      "A run looks up 1 account at 1 credit each: up to 1 credit.", "Every month, that is up to 1 credit a month.", "That is within the cap of 50 credits a month.",
    ]);
    expect(costLines(base({ cap: 0 }), 7).at(-1)).toBe("No monthly cap is set. Detection stays off until one is.");
    expect(spentLine(base())).toBe("33 of 400 credits used this month");
    expect(spentLine(base({ cap: 0, spent_this_month: 0 }))).toBe("Nothing spent this month");
    expect(runCost(base())).toEqual({ credits: 84, partial: false });
    expect(runCost(base({ remaining: 10 }))).toEqual({ credits: 10, partial: true });
  });

  it("follows the form with the same sums the server makes", () => {
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-cost', 'Cost', 'ws-cost')").run();
    const ids = Array.from({ length: 7 }, (_, index) => {
      db.prepare("INSERT INTO companies (id, workspace_id, name, domain) VALUES (?, 'ws-cost', ?, ?)").run(`cost-co-${index}`, `Company ${index}`, index < 5 ? `c${index}.test` : null);
      return `cost-co-${index}`;
    });
    watchCompanies(db, "ws-cost", null, ids);
    const stored: DetectionConfig = { enabled: false, kinds: [...DETECTION_KINDS], interval_days: 7, monthly_credit_cap: 0 };
    const start = estimate(db, "ws-cost", stored);
    for (const kinds of [[...DETECTION_KINDS], ["funding"], ["funding", "technology"], ["hiring"], []] as Array<Array<(typeof DETECTION_KINDS)[number]>>) {
      for (const interval of INTERVAL_DAYS) {
        for (const cap of [0, 9, 10, 60, 5000]) {
          expect(previewEstimate(start, kinds, interval, cap), `${kinds.join()} every ${interval} days, cap ${cap}`).toEqual(estimate(db, "ws-cost", { enabled: false, kinds, interval_days: interval, monthly_credit_cap: cap }));
        }
      }
    }
  });

  it("describes the state, a run and an account", () => {
    const config: DetectionConfig = { enabled: true, kinds: ["funding"], interval_days: 7, monthly_credit_cap: 100 };
    expect(detectionState({ config, running: false, apollo_connected: true })).toEqual({ label: "On", tone: "good" });
    expect(detectionState({ config: { ...config, enabled: false }, running: false, apollo_connected: true })).toEqual({ label: "Off", tone: "neutral" });
    expect(detectionState({ config, running: true, apollo_connected: true }).label).toBe("Checking now");
    expect(detectionState({ config: { ...config, enabled: false }, running: false, apollo_connected: false }).label).toBe("Apollo not connected");
    const run = { id: "r", trigger: "manual" as const, status: "done" as const, accounts_checked: 6, credits_spent: 12, signals_found: 3, error: null, started_at: "2026-10-10 07:00:00", finished_at: null };
    expect(runLine(run)).toBe("6 accounts checked · 3 signals · 12 credits");
    expect(runLine({ ...run, accounts_checked: 1, signals_found: 0, credits_spent: 1 })).toBe("1 account checked · nothing new · 1 credit");
    expect(runLine({ ...run, status: "failed", error: "Apollo refused the API key" })).toBe("Apollo refused the API key");
    const now = new Date("2026-10-10T12:00:00Z");
    expect(accountLine({ domain: null, last_checked_at: null, last_result: null }, now)).toBe("No website, so it cannot be looked up");
    expect(accountLine({ domain: "globex.test", last_checked_at: null, last_result: null }, now)).toBe("Not checked yet");
    expect(accountLine({ domain: "globex.test", last_checked_at: "2026-10-10 07:00:00", last_result: "Nothing new" }, now)).toBe("Nothing new · 5 h ago");
    expect(readCap("300")).toEqual({ value: 300, error: null });
    expect(readCap("3.5").error).toMatch(/whole number/);
    expect(readCap("200000").error).toMatch(/100,000/);
  });
});
