// What the signed-out pages say and where they send people, apart from how they are drawn.
import { describe, expect, it } from "vitest";
import { HIGHLIGHTS, NOTICES, asRole, inviteProblem, passwordProblem, safeCallback, scopeWords } from "@/components/auth/model";
import { MCP_SCOPES } from "@/lib/mcp/auth";

describe("where signing in sends someone", () => {
  it("is only ever a path on this site", () => {
    expect(safeCallback("/campaigns/abc?range=7d")).toBe("/campaigns/abc?range=7d");
    expect(safeCallback("/invite/tok")).toBe("/invite/tok");
    expect(safeCallback(undefined)).toBe("/");
    expect(safeCallback(["/a", "/b"])).toBe("/");
    // Somewhere else dressed as a path.
    expect(safeCallback("https://evil.example/")).toBe("/");
    expect(safeCallback("//evil.example/")).toBe("/");
    expect(safeCallback("/\\evil.example")).toBe("/");
    expect(safeCallback("javascript:alert(1)")).toBe("/");
  });

  it("has a sentence for each reason another page sends people back to sign in", () => {
    expect(Object.keys(NOTICES).sort()).toEqual(["email-verified", "password-changed", "password-reset", "session-ended"]);
  });
});

describe("what the sign-in page says about the product", () => {
  it("says nothing about price, plans or seats, and nothing about a licence", () => {
    const words = HIGHLIGHTS.map((item) => `${item.title} ${item.detail}`).join(" ");
    expect(words).not.toMatch(/pric|plan|seat|free|trial|billing|open source|licen[cs]e/i);
    expect(HIGHLIGHTS).toHaveLength(4);
  });
});

describe("an invitation", () => {
  it("names the role in a sentence", () => {
    expect(asRole("admin")).toBe("an admin");
    expect(asRole("owner")).toBe("an owner");
    expect(asRole("member")).toBe("a member");
    expect(asRole("auditor")).toBe("a auditor");
  });

  it("says why one that is not waiting cannot be used", () => {
    expect(inviteProblem({ status: "pending" })).toBeNull();
    expect(inviteProblem({ status: "accepted" })).toContain("already been used");
    expect(inviteProblem({ status: "expired" })).toContain("expired");
    expect(inviteProblem({ status: "revoked" })).toContain("withdrawn");
    expect(inviteProblem({ status: "odd" })).toContain("odd");
  });
});

describe("a new password", () => {
  it("has to be long enough and typed the same twice", () => {
    expect(passwordProblem("short", "short")).toBe("Use at least 8 characters.");
    expect(passwordProblem("long-enough-1", "long-enough-2")).toBe("The two passwords don't match.");
    expect(passwordProblem("long-enough-1", "long-enough-1")).toBeNull();
  });
});

describe("what an MCP client asks for", () => {
  it("is put in words a person can weigh, including one this version does not know", () => {
    expect(scopeWords("mcp:read")).toEqual({ title: "Read", detail: "Contacts, campaigns, the inbox, figures and settings." });
    expect(scopeWords("mcp:execute").title).toBe("Act");
    // Every scope the server can grant has its own words.
    for (const scope of MCP_SCOPES) expect(scopeWords(scope).title, scope).not.toBe(scope);
    expect(scopeWords("mcp:future")).toMatchObject({ title: "mcp:future" });
  });
});
