import {describe, expect, it} from "vitest";
import {localizeRequestError} from "../lib/client/localize-request-error";

describe("user-facing API error translation", () => {
  it("translates common API errors into Brazilian Portuguese", () => {
    expect(localizeRequestError("Your session has ended. Sign in again.", "pt-BR")).toBe("Sua sessão terminou. Entre novamente.");
    expect(localizeRequestError("An account with this email already exists.", "pt-BR")).toBe("Já existe uma conta com esse e-mail.");
    expect(localizeRequestError("The request failed (502).", "pt-BR")).toContain("502");
  });

  it("keeps the English experience unchanged", () => {
    expect(localizeRequestError("You do not have permission to do this.", "en")).toBe("You do not have permission to do this.");
  });

  it("retains unknown errors from external providers", () => {
    expect(localizeRequestError("SMTP rejected 550", "pt-BR")).toBe("SMTP rejected 550");
  });
});
