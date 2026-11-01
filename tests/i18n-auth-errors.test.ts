import {describe, expect, it} from "vitest";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {localizeAuthError} from "../lib/client/localize-auth-error";

describe("frontend translation contracts", () => {
  const flatten = (value: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(value).flatMap(([key, part]) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? flatten(part as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`]
    );

  it("keeps Portuguese and English dictionaries in sync", () => {
    expect(flatten(pt).sort()).toEqual(flatten(en).sort());
  });

  it("translates known API errors without changing API responses", () => {
    const t = (key: keyof typeof pt.AuthErrors) => pt.AuthErrors[key];
    expect(localizeAuthError("An account with this email already exists.", t)).toBe(pt.AuthErrors.duplicateEmail);
    expect(localizeAuthError("Too many attempts. Try again later.", t)).toBe(pt.AuthErrors.rateLimit);
    expect(localizeAuthError(undefined, t)).toBe(pt.AuthErrors.generic);
  });

  it("preserves unknown server errors for diagnostics", () => {
    const t = (key: keyof typeof en.AuthErrors) => en.AuthErrors[key];
    expect(localizeAuthError("A specific server error", t)).toBe("A specific server error");
  });
});
