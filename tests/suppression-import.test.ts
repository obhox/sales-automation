// The do-not-contact list as something to manage: add many entries at once, find one, and
// who may take one off. Real (throwaway) database.
import { beforeEach, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { addSuppression } from "@/lib/platform/suppression";
import suppressions from "@/pages/api/platform/suppressions";
import importHandler, { detectSuppressionKind } from "@/pages/api/platform/suppressions/import";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> & Array<Record<string, unknown>> };
}

function workspace() {
  const ws = `ws-dnc-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  return { ws, member: ctxHeaders(ws, { userId: `dnc-member-${seq}`, role: "member" }), admin: ctxHeaders(ws, { userId: `dnc-admin-${seq}`, role: "admin" }) };
}
const list = (headers: Record<string, string>, query: Record<string, string> = {}) => call(suppressions, { method: "GET", query, headers }).body;

beforeEach(() => { getDb(); });

describe("working out what a line is", () => {
  it("tells addresses, domains, profiles and phone numbers apart, and gives up on the rest", () => {
    expect(detectSuppressionKind("lee@prospect.test")).toBe("email");
    expect(detectSuppressionKind("prospect.test")).toBe("domain");
    expect(detectSuppressionKind("https://www.prospect.co.uk/about")).toBe("domain");
    expect(detectSuppressionKind("https://www.linkedin.com/in/lee-lead/")).toBe("linkedin");
    expect(detectSuppressionKind("+49 30 1234567")).toBe("phone");
    for (const junk of ["", "   ", "Lee Lead", "lee@", "12345"]) expect(detectSuppressionKind(junk), junk).toBeNull();
  });
});

describe("importing a list", () => {
  it("adds each recognised line once and says what it could not use", () => {
    const w = workspace();
    addSuppression({ workspaceId: w.ws, kind: "email", value: "already@prospect.test", reason: "manual" });

    const res = call(importHandler, { method: "POST", headers: w.member, body: { entries: [
      "email", "new@prospect.test", "ALREADY@prospect.test", "blocked-domain.test", "https://www.linkedin.com/in/someone/", "+1 415 555 0100",
      "Lee Lead", "", "second@prospect.test,Lee,Initech",
    ].join("\n") } });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ added: 5, already_listed: 1, invalid: ["Lee Lead"] });
    expect(list(w.member).map((row) => `${row.kind}:${row.value}`).sort()).toEqual([
      "domain:blocked-domain.test", "email:already@prospect.test", "email:new@prospect.test", "email:second@prospect.test",
      "linkedin:linkedin.com/in/someone", "phone:+14155550100",
    ]);
    expect(list(w.member, { q: "second" })[0]).toMatchObject({ reason: "imported", source: "import" });
  });

  it("holds every line to a kind when one is given", () => {
    const w = workspace();
    const res = call(importHandler, { method: "POST", headers: w.member, body: { kind: "email", entries: ["a@prospect.test", "prospect.test"], reason: "Trade show opt-outs" } });
    expect(res.body).toMatchObject({ added: 1, invalid: ["prospect.test"] });
    expect(list(w.member)[0]).toMatchObject({ reason: "Trade show opt-outs" });
  });

  it("refuses nothing at all, too much at once, and a kind that is not one", () => {
    const w = workspace();
    expect(call(importHandler, { method: "POST", headers: w.member, body: { entries: "\n\n" } }).statusCode).toBe(400);
    expect(call(importHandler, { method: "POST", headers: w.member, body: { entries: Array.from({ length: 5001 }, (_, i) => `x${i}@prospect.test`) } }).statusCode).toBe(400);
    expect(call(importHandler, { method: "POST", headers: w.member, body: { kind: "fax", entries: "a@prospect.test" } }).statusCode).toBe(400);
  });

  it("stays in its own workspace", () => {
    const [a, b] = [workspace(), workspace()];
    call(importHandler, { method: "POST", headers: a.member, body: { entries: "only-a@prospect.test" } });
    expect(list(b.member)).toEqual([]);
  });
});

describe("finding an entry", () => {
  it("by part of its value, by kind, or both", () => {
    const w = workspace();
    call(importHandler, { method: "POST", headers: w.member, body: { entries: "lee@initech.test\nmo@globex.test\ninitech.test" } });
    expect(list(w.member, { q: "INITECH" }).map((row) => row.value).sort()).toEqual(["initech.test", "lee@initech.test"]);
    expect(list(w.member, { kind: "domain" }).map((row) => row.value)).toEqual(["initech.test"]);
    expect(list(w.member, { q: "initech", kind: "email" }).map((row) => row.value)).toEqual(["lee@initech.test"]);
    expect(list(w.member, { q: "nobody" })).toEqual([]);
  });
});

describe("taking an entry off the list", () => {
  const idOf = (ws: string, value: string) => (db().prepare("SELECT id FROM suppressions WHERE workspace_id = ? AND value = ?").get(ws, value) as { id: string }).id;
  const remove = (headers: Record<string, string>, id: string) => call(suppressions, { method: "DELETE", query: { id }, headers }).statusCode;

  it("is any member's call for one a teammate added", () => {
    const w = workspace();
    addSuppression({ workspaceId: w.ws, kind: "email", value: "manual@prospect.test", reason: "manual", source: "manual" });
    expect(remove(w.member, idOf(w.ws, "manual@prospect.test"))).toBe(204);
    expect(list(w.member)).toEqual([]);
  });

  it("is an admin's call for one that came from an opt-out, a complaint or a bounce", () => {
    const w = workspace();
    addSuppression({ workspaceId: w.ws, kind: "email", value: "optout@prospect.test", reason: "unsubscribed", source: "linki" });
    addSuppression({ workspaceId: w.ws, kind: "email", value: "replied@prospect.test", reason: "unsubscribe", source: "reply_classifier" });
    addSuppression({ workspaceId: w.ws, kind: "email", value: "bounced@prospect.test", reason: "bounced", source: "linki" });

    for (const value of ["optout@prospect.test", "replied@prospect.test", "bounced@prospect.test"]) {
      expect(remove(w.member, idOf(w.ws, value)), value).toBe(403);
    }
    expect(list(w.member)).toHaveLength(3);
    expect(remove(w.admin, idOf(w.ws, "optout@prospect.test"))).toBe(204);
    expect(list(w.member)).toHaveLength(2);
  });

  it("cannot reach into another workspace", () => {
    const [a, b] = [workspace(), workspace()];
    addSuppression({ workspaceId: a.ws, kind: "email", value: "theirs@prospect.test", reason: "manual", source: "manual" });
    remove(b.admin, idOf(a.ws, "theirs@prospect.test"));
    expect(list(a.member)).toHaveLength(1);
  });
});
