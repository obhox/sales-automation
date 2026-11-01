import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("contact dialogs and individual profile localization", () => {
  it("keeps every new catalog key aligned", () => {
    expect(Object.keys(pt.ContactDialogs).sort()).toEqual(Object.keys(en.ContactDialogs).sort());
    expect(Object.keys(pt.ContactProfile).sort()).toEqual(Object.keys(en.ContactProfile).sort());
  });

  it("translates contact creation, list selection and campaigns", () => {
    expect(br("ContactDialogs.addContactTitle")).toBe("Adicionar contato");
    expect(br("ContactDialogs.atCompany", {name: "ACME"})).toContain("ACME");
    expect(br("ContactDialogs.addToListDescription", {count: 2})).toContain("2 contatos");
    expect(br("ContactDialogs.listAdded", {count: 1, name: "Prospects"})).toContain("Prospects");
    expect(br("ContactDialogs.enrolledSummary", {name: "Piloto", count: 2, already: 1, elsewhere: 0})).toContain("Piloto");
    expect(english("ContactDialogs.addContactTitle")).toBe("Add a contact");
  });

  it("translates tags, research credit warnings and progress", () => {
    expect(br("ContactDialogs.tagsAdded", {count: 3, contacts: "5 contatos"})).toContain("etiquetas");
    expect(br("ContactDialogs.enrichCost", {count: 5})).toContain("Apollo");
    expect(br("ContactDialogs.researchSkippedNoSite", {count: 2})).toContain("2 contatos");
    expect(br("ContactDialogs.researchOutcome", {done: 3, written: 1, noHook: 1, skipped: 1})).toContain("abordagens");
    expect(br("ContactDialogs.colorNeutral")).toBe("Cinza");
  });

  it("translates profile warnings and owner changes", () => {
    expect(br("ContactProfile.replyTitle", {name: "Ana", where: "por e-mail"})).toContain("Ana");
    expect(br("ContactProfile.replyBody")).toContain("interrompidas");
    expect(br("ContactProfile.deleteContactBody")).toContain("irreversível");
    expect(br("ContactProfile.ownerConfirmation", {name: "Ana", owner: "Bruno"})).toContain("Bruno");
    expect(english("ContactProfile.refreshProfile")).toBe("Refresh profile");
  });
});
