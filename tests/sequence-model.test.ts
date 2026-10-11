// The sequence as the builder holds it: opening and saving lose nothing, edits do what
// their names say, and what the screen says about a step is worked out here.
import { describe, expect, it } from "vitest";
import {
  DAY, HOUR, addStep, defaultGate, docFrom, draftOf, findRow, fingerprint, gateKindsFor, gateOn, gateTitle, insertAt, laneItems, leader, mergeTags, moveStep, nudgeStep, outcomeChoices,
  outcomeLabel, removeRow, restoreGate, restoreStep, sequenceProblems, setGate, setWaitBefore, splitLabel, stepProblems, stepSubline, stepTitle, updateRow, versionShares, versionsOf,
  waitBefore, waitLabel, isNegative,
  type BuilderData, type Doc, type SequenceDraft, type StepFigures,
} from "@/components/sequence/model";

const published: SequenceDraft = {
  steps: [
    { id: "v", track: "linkedin", step_type: "visit" },
    { id: "d1", track: "linkedin", step_type: "delay", delay_seconds: DAY },
    { id: "c", track: "linkedin", step_type: "connect", connect_note: "Hi {{first_name}}" },
    { id: "d2", track: "linkedin", step_type: "delay", delay_seconds: 3 * DAY },
    { id: "m", track: "linkedin", step_type: "message", message_body: "Thanks for connecting" },
    { id: "d3", track: "email", step_type: "delay", delay_seconds: DAY },
    { id: "e1", track: "email", step_type: "email", email_subject: "Hello", email_body: "Hi {{first_name}}", email_variants: [{ id: "var-b", subject: "Hello B", body: "B" }] },
    { id: "d4", track: "email", step_type: "delay", delay_seconds: 3 * DAY },
    { id: "e2", track: "email", step_type: "email", email_subject: "Again", email_body: "Following up", email_in_thread: 1 },
  ],
  gates: [{ source: "c", kind: "connected", on_true: { then: "continue" }, on_false: { then: "handover_email" } }],
  settings: { email_start: "enrolment", linkedin_track_enabled: true, email_track_enabled: true },
};
const open = (): Doc => docFrom(published);
const order = (doc: Doc, track: "linkedin" | "email") => doc[track].map((row) => (row.step_type === "delay" ? `wait:${Number(row.delay_seconds) / DAY}d` : row.id ?? row.step_type));
const templates: BuilderData["templates"] = [
  { id: "t-li", name: "Follow-up", body: "Hi", channel: "linkedin", subject: null, category: null, created_at: "" },
  { id: "t-mail", name: "Intro", body: "Hi", channel: "email", subject: "S", category: "Intros", created_at: "" },
];

describe("opening and saving", () => {
  it("gives the engine back what it was given", () => {
    const draft = draftOf(open());
    expect(draft.steps.map((step) => step.id)).toEqual(published.steps.map((step) => step.id));
    expect(draft.steps.every((step) => step.key === null)).toBe(true);
    expect(draft.steps.filter((step) => step.step_type === "email").map((step) => step.email_position)).toEqual([1, 2]);
    expect(draft.gates).toEqual([{ source: "c", kind: "connected", on_true: { then: "continue" }, on_false: { then: "handover_email" } }]);
    expect(draft.settings).toEqual(published.settings);
  });

  it("names a new step by a key until it is published, and keeps that key through a stored draft", () => {
    const added = addStep(open(), "email", "email");
    const draft = draftOf(added.doc);
    const fresh = draft.steps.find((step) => step.key === added.ref)!;
    expect(fresh).toMatchObject({ id: null, step_type: "email", email_position: 3 });
    // Reopened from the stored draft, it is the same step.
    expect(findRow(docFrom(draft), added.ref)?.step_type).toBe("email");
    expect(fingerprint(docFrom(draft))).toBe(fingerprint(added.doc));
  });

  it("treats an absent field and an empty one as the same, and any real change as a change", () => {
    const base = fingerprint(open());
    const spelled = docFrom({ ...published, steps: published.steps.map((step) => ({ ...step, ai_enabled: 0, connect_note: step.connect_note ?? null, email_signature: null, template_ids: [] })) });
    expect(fingerprint(spelled)).toBe(base);
    // A gate with its default outcomes spelled out or not.
    const defaults = docFrom({ ...published, gates: [{ source: "m", kind: "no_reply" }] });
    const explicit = docFrom({ ...published, gates: [{ source: "m", kind: "no_reply", on_true: { then: "continue" }, on_false: { then: "leave" } }] });
    expect(fingerprint(defaults)).toBe(fingerprint(explicit));

    expect(fingerprint(updateRow(open(), "m", { message_body: "Thanks for connecting!" }))).not.toBe(base);
    expect(fingerprint({ ...open(), settings: { ...open().settings, email_track_enabled: false } })).not.toBe(base);
    // Midnight is a real hour: a window from 00:00 is not the same as no window.
    expect(fingerprint(updateRow(open(), "m", { window_start: 0, window_end: 6 }))).not.toBe(fingerprint(updateRow(open(), "m", { window_start: null, window_end: 6 })));
  });

  it("drops a gate whose step is gone, and the first email never claims to be a reply", () => {
    const orphan = docFrom({ ...published, gates: [{ source: "no-such-step", kind: "no_reply" }] });
    expect(orphan.gates).toEqual([]);
    const draft = draftOf(docFrom({ ...published, steps: published.steps.map((step) => (step.id === "e1" ? { ...step, email_in_thread: 1 } : step)) }));
    expect(draft.steps.find((step) => step.id === "e1")?.email_in_thread).toBe(0);
    expect(draft.steps.find((step) => step.id === "e2")?.email_in_thread).toBe(1);
  });
});

describe("changing the sequence", () => {
  it("adds a step a day after what came before, and the first step of a track with no wait", () => {
    const added = addStep(open(), "linkedin", "message");
    expect(order(added.doc, "linkedin")).toEqual(["v", "wait:1d", "c", "wait:3d", "m", "wait:1d", "message"]);
    const empty = docFrom({ steps: [], gates: [] });
    expect(addStep(empty, "email", "email").doc.email.map((row) => row.step_type)).toEqual(["email"]);
  });

  it("sets, adds and removes the wait before a step", () => {
    expect(waitBefore(open(), "c")?.delay_seconds).toBe(DAY);
    expect(order(setWaitBefore(open(), "c", 2 * DAY), "linkedin")).toEqual(["v", "wait:2d", "c", "wait:3d", "m"]);
    expect(order(setWaitBefore(open(), "c", 0), "linkedin")).toEqual(["v", "c", "wait:3d", "m"]);
    expect(order(setWaitBefore(open(), "v", DAY), "linkedin")).toEqual(["wait:1d", "v", "wait:1d", "c", "wait:3d", "m"]);
    // A wait with a condition on it stays, at an hour at least.
    const gated = setGate(open(), "d2", defaultGate({ step_type: "delay" }));
    expect(waitBefore(setWaitBefore(gated, "m", 0), "m")?.delay_seconds).toBe(HOUR);
  });

  it("removes a step with its wait and its condition, and sends a skip that pointed at it onwards instead", () => {
    const jumping = setGate(open(), "v", { kind: "conditions", conditions: { mode: "all", conditions: [{ field: "replied", operator: "exists" }] }, on_true: { then: "jump", step: "m" }, on_false: { then: "continue" } });
    const removed = removeRow(jumping, "m");
    expect(order(removed, "linkedin")).toEqual(["v", "wait:1d", "c"]);
    expect(gateOn(removed, "v")?.on_true).toEqual({ then: "continue", step: null });
    expect(gateOn(removeRow(open(), "c"), "c")).toBeNull();
    expect(order(removeRow(open(), "c"), "linkedin")).toEqual(["v", "wait:3d", "m"]);
  });

  it("moves a step with its own wait, and leaves the other steps theirs", () => {
    // The message, with its three-day wait, goes in front of the connection request.
    expect(order(moveStep(open(), "m", "c"), "linkedin")).toEqual(["v", "wait:3d", "m", "wait:1d", "c"]);
    expect(order(moveStep(open(), "v", null), "linkedin")).toEqual(["wait:1d", "c", "wait:3d", "m", "v"]);
    // Never across tracks, and a step dropped on itself stays put.
    expect(moveStep(open(), "m", "e1")).toEqual(open());
    expect(order(moveStep(open(), "m", "m"), "linkedin")).toEqual(order(open(), "linkedin"));
    expect(order(nudgeStep(open(), "m", -1), "linkedin")).toEqual(["v", "wait:3d", "m", "wait:1d", "c"]);
    expect(order(nudgeStep(open(), "v", 1), "linkedin")).toEqual(["wait:1d", "c", "v", "wait:3d", "m"]);
    expect(nudgeStep(open(), "v", -1)).toEqual(open());
    // Every row is still there afterwards.
    expect(moveStep(open(), "m", "v").linkedin.map((row) => row.ref).sort()).toEqual(open().linkedin.map((row) => row.ref).sort());
  });

  it("puts one step, or one condition, back as it was without touching the rest", () => {
    const before = open();
    let edited = updateRow(before, "m", { message_body: "Changed", ai_enabled: 1 });
    edited = setWaitBefore(edited, "m", 5 * DAY);
    edited = updateRow(edited, "c", { connect_note: "Also changed" });
    const restored = restoreStep(edited, before, "m");
    expect(findRow(restored, "m")).toEqual(findRow(before, "m"));
    expect(waitBefore(restored, "m")?.delay_seconds).toBe(3 * DAY);
    expect(findRow(restored, "c")?.connect_note).toBe("Also changed");

    const regated = setGate(before, "c", { kind: "no_reply", on_true: { then: "continue" }, on_false: { then: "leave" } });
    expect(gateOn(restoreGate(regated, before, "c"), "c")?.kind).toBe("connected");
    const added = setGate(before, "m", defaultGate({ step_type: "message" }));
    expect(gateOn(restoreGate(added, before, "m"), "m")).toBeNull();
  });
});

describe("what a track looks like", () => {
  it("works out each step's day and which of its kind it is", () => {
    expect(laneItems(open(), "linkedin").filter((item) => item.day !== null).map((item) => [item.row.id, item.day, item.number])).toEqual([["v", 1, 1], ["c", 2, 1], ["m", 5, 1]]);
    expect(laneItems(open(), "email").filter((item) => item.day !== null).map((item) => [stepTitle(item), item.day])).toEqual([["Email 1 — Hello", 2], ["Email 2 — Again", 5]]);
    const more = addStep(addStep(open(), "linkedin", "message").doc, "linkedin", "message").doc;
    expect(laneItems(more, "linkedin").filter((item) => item.row.step_type === "message").map(stepTitle)).toEqual(["LinkedIn message", "LinkedIn follow-up", "LinkedIn follow-up 2"]);
    expect(laneItems(open(), "linkedin").find((item) => item.row.id === "c")?.gate?.kind).toBe("connected");
  });

  it("words a wait", () => {
    expect(waitLabel(DAY)).toBe("Wait 1 day");
    expect(waitLabel(2 * DAY)).toBe("Wait 2 days");
    expect(waitLabel(6 * HOUR)).toBe("Wait 6 hours");
    expect(waitLabel(DAY + 12 * HOUR)).toBe("Wait 1 day 12 hours");
    expect(waitLabel(0)).toBe("No wait");
  });

  it("says what a step has done, or failing that what it will do", () => {
    const figures: StepFigures = { sent: 200, contacts: 200, opened: 80, clicked: 4, replied: 12, bounced: 2, requests: 0, accepted: 0 };
    const email = findRow(open(), "e1")!;
    expect(stepSubline({ ...email, email_track_opens: 1 }, figures, 0)).toBe("200 sent · 40.0% opened · 6.0% replied");
    expect(stepSubline(email, { ...figures, opened: 0 }, 0)).toBe("200 sent · 6.0% replied");
    expect(stepSubline(findRow(open(), "c")!, { ...figures, requests: 200, accepted: 76 }, 0)).toBe("200 sent · 38.0% accepted");
    expect(stepSubline(findRow(open(), "v")!, undefined, 0)).toBe("Warms the profile before you write");
    expect(stepSubline(findRow(open(), "m")!, undefined, 0)).toBe("Thanks for connecting");
    expect(stepSubline(findRow(open(), "m")!, undefined, 3)).toBe("Rotates 3 templates");
    expect(stepSubline({ ...findRow(open(), "m")!, ai_enabled: 1 }, undefined, 0)).toBe("Written by AI for each contact");
    expect(stepSubline({ ...findRow(open(), "m")!, message_body: "" }, undefined, 0)).toBe("Nothing written yet");
  });
});

describe("A/B versions", () => {
  it("shares sends equally unless weights say otherwise, always adding up to 100", () => {
    expect(versionsOf(findRow(open(), "e1")!).map((version) => [version.index, version.subject])).toEqual([[0, "Hello"], [1, "Hello B"]]);
    expect(versionShares([{ weight: null }, { weight: null }, { weight: null }])).toEqual([34, 33, 33]);
    expect(versionShares([{ weight: 3 }, { weight: 1 }])).toEqual([75, 25]);
    expect(versionShares([{ weight: 2 }, { weight: 2 }])).toEqual([50, 50]);
    expect(splitLabel([{ weight: null }, { weight: null }, { weight: null }, { weight: null }])).toBe("Even split · 25% each");
    expect(splitLabel([{ weight: 3 }, { weight: 1 }])).toBe("Split A 75% · B 25%");
  });

  it("calls a version ahead only with enough sends on both sides and a better reply rate", () => {
    const row = findRow(open(), "e1")!;
    const figures = (a: [number, number], b: [number, number]) => [
      { variant_id: null, paused: false, sent: a[0], replied: a[1], contacts: a[0], opened: 0, clicked: 0, bounced: 0, requests: 0, accepted: 0 },
      { variant_id: "var-b", paused: false, sent: b[0], replied: b[1], contacts: b[0], opened: 0, clicked: 0, bounced: 0, requests: 0, accepted: 0 },
    ];
    expect(leader(row, figures([100, 4], [100, 9]))).toEqual({ index: 1, rate: 0.09 });
    expect(leader(row, figures([100, 9], [100, 4]))).toEqual({ index: 0, rate: 0.09 });
    expect(leader(row, figures([100, 4], [12, 6]))).toBeNull();
    expect(leader(row, figures([100, 5], [100, 5]))).toBeNull();
    expect(leader(row, undefined)).toBeNull();
  });
});

describe("conditions", () => {
  it("names a condition by what it checks", () => {
    const doc = open();
    expect(gateTitle(gateOn(doc, "c")!)).toBe("If connection accepted");
    const intent = { source: "e1", kind: "conditions" as const, conditions: { mode: "all" as const, conditions: [{ field: "intent_score", operator: "gte" as const, value: 70 }] }, on_true: { then: "continue" as const }, on_false: { then: "end_track" as const } };
    expect(gateTitle(intent)).toBe("If intent score ≥ 70");
    expect(gateTitle({ ...intent, conditions: { mode: "any", conditions: [{ field: "replied", operator: "not_exists" }, { field: "custom.segment", operator: "is", value: "Enterprise" }] } }, [{ key: "segment", name: "Segment" }]))
      .toBe("If not replied or Segment is Enterprise");
    expect(gateTitle({ ...intent, conditions: { mode: "all", conditions: [{ field: "signal_exists", operator: "exists", value: "funding" }] } })).toBe("If has a funding signal");
    expect(gateTitle({ ...intent, conditions: { mode: "all", conditions: [] } })).toBe("If… (no condition chosen yet)");
    // Older conditions compared with true or false rather than set or not set.
    expect(isNegative({ field: "connected", operator: "is", value: false })).toBe(true);
    expect(isNegative({ field: "connected", operator: "is", value: true })).toBe(false);
    expect(isNegative({ field: "connected", operator: "exists" })).toBe(false);
  });

  it("words each side, and offers only the outcomes that make sense there", () => {
    const gate = gateOn(open(), "c")!;
    const titles = new Map([["m", "LinkedIn message"]]);
    expect(outcomeLabel(gate.on_false, "false", gate, titles)).toBe("Hand over to the email track");
    expect(outcomeLabel({ then: "jump", step: "m" }, "true", gate, titles)).toBe("Skip ahead to LinkedIn message");
    expect(outcomeLabel({ then: "leave", effects: [{ type: "add_to_list", list_id: "l1" }, { type: "create_task", title: "Call them" }] }, "false", gate, titles, [{ id: "l1", name: "Nurture" }]))
      .toBe("Leave the sequence · add to Nurture · task: Call them");

    expect(outcomeChoices({ kind: "no_reply" }, "false", "linkedin", 2).map((choice) => choice.value)).toEqual(["leave"]);
    expect(outcomeChoices({ kind: "connected" }, "false", "linkedin", 2).map((choice) => choice.value)).toEqual(["continue", "jump", "end_track", "handover_email", "leave"]);
    // Email cannot hand over to itself, and with no later step there is nowhere to skip to.
    expect(outcomeChoices({ kind: "conditions" }, "true", "email", 0).map((choice) => choice.value)).toEqual(["continue", "end_track", "leave"]);
    expect(gateKindsFor({ step_type: "connect" })).toEqual(["connected", "no_reply", "conditions"]);
    expect(gateKindsFor({ step_type: "email" })).toEqual(["verified_email", "no_reply", "conditions"]);
    expect(gateKindsFor({ step_type: "message" })).toEqual(["no_reply", "conditions"]);
    expect(defaultGate({ step_type: "connect" })).toEqual({ kind: "connected", on_true: { then: "continue" }, on_false: { then: "end_track" } });
  });
});

describe("checking a sequence before it is saved", () => {
  it("says what would stop a step doing its job", () => {
    const doc = open();
    expect(stepProblems(findRow(doc, "e1")!, templates, [])).toEqual([]);
    expect(stepProblems({ ...findRow(doc, "m")!, message_body: "" }, templates, [])).toEqual(["Nothing to send yet: write the message, pick templates, or let AI write it"]);
    expect(stepProblems({ ...findRow(doc, "m")!, message_body: "", template_ids: ["t-li"] }, templates, [])).toEqual([]);
    // A template written for email does not fill a LinkedIn step.
    expect(stepProblems({ ...findRow(doc, "m")!, message_body: "", template_ids: ["t-mail"] }, templates, [])).toHaveLength(1);
    expect(stepProblems({ ...findRow(doc, "c")!, connect_note: "x".repeat(301) }, templates, [])).toEqual(["The note is over LinkedIn's 300 characters"]);
    expect(stepProblems({ ...findRow(doc, "e1")!, email_body: "Hi {{frist_name}}" }, templates, [])).toEqual(["{{frist_name}} is not a field on a contact. It will be sent as written."]);
    expect(stepProblems({ ...findRow(doc, "e1")!, email_body: "{{custom.segment}} {{sender.first_name}} {{unsubscribe}}" }, templates, ["segment"])).toEqual([]);
    expect(stepProblems({ ...findRow(doc, "e1")!, email_variants: [{ subject: "", body: "" }] }, templates, [])).toEqual(["Version B needs a subject", "Version B has nothing written yet"]);
    // A reply in the same thread takes the first email's subject, so it needs none of its own.
    expect(stepProblems({ ...findRow(doc, "e2")!, email_subject: "" }, templates, [])).toEqual([]);
    expect(stepProblems({ ...findRow(doc, "m")!, ai_enabled: 1, ai_prompt: "" }, templates, [])).toEqual(["Tell the AI what this step should say"]);
  });

  it("catches a skip that goes backwards, and a condition with nothing to check", () => {
    const backwards = setGate(open(), "m", { kind: "conditions", conditions: { mode: "all", conditions: [{ field: "replied", operator: "exists" }] }, on_true: { then: "jump", step: "c" }, on_false: { then: "continue" } });
    expect(sequenceProblems(backwards, templates, []).map((problem) => problem.message)).toEqual(["If replied: a skip must go to a later step of the same track"]);
    const empty = setGate(open(), "m", { kind: "conditions", conditions: { mode: "all", conditions: [] }, on_true: { then: "continue" }, on_false: { then: "continue" } });
    expect(sequenceProblems(empty, templates, [])).toEqual([{ ref: "m", message: "A condition has nothing chosen to check" }]);
    expect(sequenceProblems(open(), templates, [])).toEqual([]);
  });
});

describe("merge tags in the editor", () => {
  it("offers the contact's fields, the workspace's own, the sender's, and for email the unsubscribe link", () => {
    const tags = mergeTags([{ key: "trigger", name: "Trigger" }]).map((tag) => tag.tag);
    expect(tags).toContain("{{custom.trigger}}");
    expect(tags).toContain("{{sender.first_name}}");
    expect(tags).not.toContain("{{unsubscribe}}");
    expect(mergeTags([], { email: true }).map((tag) => tag.tag)).toEqual(expect.arrayContaining(["{{unsubscribe}}", "{{sender.email}}"]));
  });

  it("puts a tag where the caret is, or over what is selected", () => {
    expect(insertAt("Hi , welcome", "{{first_name}}", 3, 3)).toEqual({ text: "Hi {{first_name}}, welcome", caret: 17 });
    expect(insertAt("Hi NAME, welcome", "{{first_name}}", 3, 7)).toEqual({ text: "Hi {{first_name}}, welcome", caret: 17 });
    expect(insertAt("Hi", "{{company}}", 99, 99)).toEqual({ text: "Hi{{company}}", caret: 13 });
  });
});
