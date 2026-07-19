import { describe, it, expect } from "vitest";
import {
  signupSchema,
  suppressionCreateSchema,
  apiContactCreateSchema,
  apiSignalCreateSchema,
  firstIssue,
} from "@/lib/validation";

describe("signupSchema", () => {
  it("accepts a valid signup", () => {
    const r = signupSchema.safeParse({ email: "a@b.com", password: "supersecret" });
    expect(r.success).toBe(true);
  });

  it("preserves the required-field message when password is missing", () => {
    const r = signupSchema.safeParse({ email: "a@b.com" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("Email and password are required.");
  });

  it("preserves the short-password message", () => {
    const r = signupSchema.safeParse({ email: "a@b.com", password: "short" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("Password must be at least 8 characters.");
  });

  it("rejects an oversized password before it can reach bcrypt", () => {
    const r = signupSchema.safeParse({ email: "a@b.com", password: "x".repeat(5000) });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("Password is too long.");
  });

  it("rejects a non-string password", () => {
    const r = signupSchema.safeParse({ email: "a@b.com", password: 12345678 });
    expect(r.success).toBe(false);
  });
});

describe("suppressionCreateSchema", () => {
  it("accepts a valid suppression", () => {
    const r = suppressionCreateSchema.safeParse({ kind: "email", value: "spam@x.com" });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown kind with the original message", () => {
    const r = suppressionCreateSchema.safeParse({ kind: "carrier-pigeon", value: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("Valid kind and value are required");
  });

  it("rejects a blank value with the original message", () => {
    const r = suppressionCreateSchema.safeParse({ kind: "email", value: "   " });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("Valid kind and value are required");
  });
});

describe("apiContactCreateSchema", () => {
  it("accepts a minimal contact and allows null optionals", () => {
    const r = apiContactCreateSchema.safeParse({ full_name: "Jane Doe", email: null });
    expect(r.success).toBe(true);
  });

  it("rejects an oversized full_name", () => {
    const r = apiContactCreateSchema.safeParse({ full_name: "x".repeat(1000) });
    expect(r.success).toBe(false);
  });
});

describe("apiSignalCreateSchema", () => {
  it("accepts a signal and keeps metadata opaque", () => {
    const r = apiSignalCreateSchema.safeParse({
      type: "job_change",
      title: "New role",
      metadata: { any: "thing" },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({ any: "thing" });
  });

  it("rejects an oversized type", () => {
    const r = apiSignalCreateSchema.safeParse({ type: "x".repeat(200), title: "ok" });
    expect(r.success).toBe(false);
  });
});
