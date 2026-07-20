import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));

import { getServerSession } from "next-auth/next";
import { superadminEmails, isSuperadminEmail, requireSuperadmin } from "@/lib/superadmin";

const mockedSession = vi.mocked(getServerSession);

function env(value?: string): NodeJS.ProcessEnv {
  return (value === undefined ? {} : { SUPERADMIN_EMAILS: value }) as NodeJS.ProcessEnv;
}

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

beforeEach(() => {
  mockedSession.mockReset();
  delete process.env.SUPERADMIN_EMAILS;
});

describe("superadminEmails", () => {
  it("parses, trims and lowercases a comma-separated allowlist", () => {
    expect(superadminEmails(env(" Admin@Example.com , ops@example.com "))).toEqual([
      "admin@example.com",
      "ops@example.com",
    ]);
  });

  it("is empty when unset or blank", () => {
    expect(superadminEmails(env())).toEqual([]);
    expect(superadminEmails(env("   "))).toEqual([]);
    expect(superadminEmails(env(",,"))).toEqual([]);
  });
});

describe("isSuperadminEmail", () => {
  it("fails closed when the allowlist is unset", () => {
    // The dangerous default would be "no allowlist means everyone".
    expect(isSuperadminEmail("anyone@example.com", env())).toBe(false);
  });

  it("fails closed when the allowlist is blank", () => {
    expect(isSuperadminEmail("anyone@example.com", env("  "))).toBe(false);
  });

  it("matches case-insensitively and tolerates whitespace", () => {
    const e = env("admin@example.com");
    expect(isSuperadminEmail("ADMIN@example.com", e)).toBe(true);
    expect(isSuperadminEmail("  admin@example.com  ", e)).toBe(true);
  });

  it("rejects an email that is not listed", () => {
    expect(isSuperadminEmail("someone@example.com", env("admin@example.com"))).toBe(false);
  });

  it("rejects empty identities", () => {
    const e = env("admin@example.com");
    expect(isSuperadminEmail(null, e)).toBe(false);
    expect(isSuperadminEmail(undefined, e)).toBe(false);
    expect(isSuperadminEmail("", e)).toBe(false);
  });
});

describe("requireSuperadmin", () => {
  const req = {} as NextApiRequest;

  it("returns the admin email for an allowlisted session", async () => {
    process.env.SUPERADMIN_EMAILS = "admin@example.com";
    mockedSession.mockResolvedValue({ user: { email: "Admin@example.com" } } as never);
    const res = mockRes();
    await expect(requireSuperadmin(req, res)).resolves.toBe("admin@example.com");
    expect(res.statusCode).toBe(200);
  });

  it("responds 404 (not 403) for a signed-in non-admin, hiding the surface", async () => {
    process.env.SUPERADMIN_EMAILS = "admin@example.com";
    mockedSession.mockResolvedValue({ user: { email: "member@example.com" } } as never);
    const res = mockRes();
    await expect(requireSuperadmin(req, res)).resolves.toBeNull();
    expect(res.statusCode).toBe(404);
  });

  it("rejects when there is no session at all", async () => {
    process.env.SUPERADMIN_EMAILS = "admin@example.com";
    mockedSession.mockResolvedValue(null as never);
    const res = mockRes();
    await expect(requireSuperadmin(req, res)).resolves.toBeNull();
    expect(res.statusCode).toBe(404);
  });

  it("rejects everyone when the allowlist is unset, even with a valid session", async () => {
    mockedSession.mockResolvedValue({ user: { email: "admin@example.com" } } as never);
    const res = mockRes();
    await expect(requireSuperadmin(req, res)).resolves.toBeNull();
    expect(res.statusCode).toBe(404);
  });

  it("ignores forged workspace-role headers", async () => {
    // proxy.ts injects x-workspace-role and lib/workspace.ts defaults it to "owner",
    // so a header-based check would be forgeable. The guard must use the signed
    // session only - an owner header with no session must still be rejected.
    process.env.SUPERADMIN_EMAILS = "admin@example.com";
    mockedSession.mockResolvedValue(null as never);
    const forged = {
      headers: {
        "x-workspace-role": "owner",
        "x-user-id": "someone",
        "x-workspace-id": "00000000-0000-4000-8000-000000000001",
      },
    } as unknown as NextApiRequest;
    const res = mockRes();
    await expect(requireSuperadmin(forged, res)).resolves.toBeNull();
    expect(res.statusCode).toBe(404);
  });
});
