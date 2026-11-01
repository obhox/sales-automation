import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("lists and LinkedIn accounts localization", () => {
  it("translates list filters, warnings and confirmations", () => {
    expect(br("Lists.title")).toBe("Listas");
    expect(br("Lists.deleteTitle", {name: "Prospects"})).toContain("Prospects");
    expect(br("Lists.firstContacts", {first: 100, total: 150})).toContain("100");
    expect(br("Lists.column.source")).toBe("Origem");
    expect(english("Lists.newList")).toBe("New list");
  });

  it("translates LinkedIn actions while preserving names and limits", () => {
    expect(br("LinkedinAccounts.title")).toBe("Contas do LinkedIn");
    expect(br("LinkedinAccounts.cleanupOnBody", {waiting: 8, days: 14, limit: 3})).toContain("14");
    expect(br("LinkedinAccounts.pauseTitle", {name: "Conta 1"})).toContain("Conta 1");
    expect(br("LinkedinAccounts.syncSummary", {count: 22, accepted: 2, corrected: "", partial: ""})).toContain("22");
    expect(english("LinkedinAccounts.disconnectConfirm")).toBe("Disconnect");
  });
});
