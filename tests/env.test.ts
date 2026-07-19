import { describe, it, expect, vi } from "vitest";
import { validateEnv } from "@/lib/env";

describe("validateEnv", () => {
  it("throws in production when NEXTAUTH_SECRET is missing", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => validateEnv(env)).toThrowError(/NEXTAUTH_SECRET/);
  });

  it("does not throw in production when NEXTAUTH_SECRET is present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      NODE_ENV: "production",
      NEXTAUTH_SECRET: "x".repeat(32),
      NEXTAUTH_URL: "https://example.com",
      INTERNAL_API_SECRET: "y".repeat(32),
    } as NodeJS.ProcessEnv;
    expect(() => validateEnv(env)).not.toThrow();
    warn.mockRestore();
  });

  it("warns (does not throw) for missing recommended vars", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { NODE_ENV: "production", NEXTAUTH_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv;
    const warnings = validateEnv(env);
    const names = warnings.map((w) => w.name);
    expect(names).toContain("NEXTAUTH_URL");
    expect(names).toContain("INTERNAL_API_SECRET");
    warn.mockRestore();
  });

  it("does not throw outside production even when required vars are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(() => validateEnv(env)).not.toThrow();
    warn.mockRestore();
  });

  it("treats a blank NEXTAUTH_SECRET as missing", () => {
    const env = { NODE_ENV: "production", NEXTAUTH_SECRET: "   " } as NodeJS.ProcessEnv;
    expect(() => validateEnv(env)).toThrowError(/NEXTAUTH_SECRET/);
  });
});
