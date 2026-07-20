import { describe, it, expect, beforeAll, vi } from "vitest";

// Force failures at two different points of classifyAndDispatch so we can exercise the
// safety net. Both mocks keep the real module and override a single function, because
// lib/db imports encryptSecret/isEncrypted and lib/platform/events is used elsewhere.
vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto")>();
  return {
    ...actual,
    // Called in classifyReply BEFORE targets.email_replied_at is stamped - this is the hole.
    decryptSecret: () => {
      throw new Error("simulated decrypt failure");
    },
  };
});
vi.mock("@/lib/platform/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/events")>();
  return {
    ...actual,
    // Called at the very end, AFTER the out-of-office reschedule has been applied.
    emitDomainEvent: () => {
      throw new Error("simulated event bus failure");
    },
  };
});

import { getDb } from "@/lib/db";
import { classifyAndDispatch } from "@/lib/community-replies";

const WS = "ws-reply-0001";

beforeAll(() => {
  getDb().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Reply WS", "reply-ws");
});

let seq = 0;
/** Seed a contact enrolled in a run with a live email + linkedin track, plus a reply row. */
function seedReply(bodyText: string) {
  const db = getDb();
  const n = ++seq;
  const targetId = `tgt-${n}`;
  const runId = `run-${n}`;
  const profileId = `rp-${n}`;
  const replyId = `rep-${n}`;

  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)").run(
    targetId, WS, `Contact ${n}`, `contact${n}@example.com`,
  );
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, NULL, 'running')").run(runId);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profileId, runId, targetId);
  for (const track of ["email", "linkedin"]) {
    db.prepare(
      "INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, ?, 'in_progress')",
    ).run(`${profileId}-${track}`, profileId, track);
  }
  db.prepare(
    `INSERT INTO email_replies (id, workspace_id, target_id, run_id, from_email, subject, body_text, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(replyId, WS, targetId, runId, `contact${n}@example.com`, "Re: quick question", bodyText);

  return { targetId, replyId, profileId };
}

function trackStates(profileId: string): string[] {
  return (
    getDb()
      .prepare("SELECT state FROM run_profile_tracks WHERE run_profile_id = ? ORDER BY track")
      .all(profileId) as Array<{ state: string }>
  ).map((r) => r.state);
}

function repliedAt(targetId: string): string | null {
  return (getDb().prepare("SELECT email_replied_at FROM targets WHERE id = ?").get(targetId) as {
    email_replied_at: string | null;
  }).email_replied_at;
}

describe("reply dispatch safety net", () => {
  it("stops every track when dispatch fails before the reply is stamped", async () => {
    // Neutral text so no deterministic rule matches and classifyReply is reached,
    // where the mocked decryptSecret throws - before targets.email_replied_at is set.
    const { targetId, replyId, profileId } = seedReply("Received your note.");

    await expect(classifyAndDispatch(replyId)).rejects.toThrow(/simulated decrypt failure/);

    // Without the safety net this contact stays enrolled and keeps getting follow-ups.
    expect(repliedAt(targetId)).not.toBeNull();
    expect(trackStates(profileId)).toEqual(["email", "linkedin"].map(() => "skipped"));

    const row = getDb().prepare("SELECT classification_error FROM email_replies WHERE id = ?").get(replyId) as {
      classification_error: string | null;
    };
    expect(row.classification_error).toMatch(/simulated decrypt failure/);
  });

  it("does NOT stop an out-of-office auto-reply", async () => {
    // Matches the OOO rule at high confidence, so classification succeeds and the
    // reschedule is applied; the mocked emitDomainEvent then throws at the end.
    const { targetId, profileId, replyId } = seedReply("Automatic reply: I am out of office until Monday.");

    await expect(classifyAndDispatch(replyId)).rejects.toThrow(/simulated event bus failure/);

    // OOO must remain enrolled so the sequence resumes when they are back.
    expect(repliedAt(targetId)).toBeNull();
    expect(trackStates(profileId)).toEqual(["in_progress", "in_progress"]);
  });
});
