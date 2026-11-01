import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import {formatRelativeByLocale} from "../lib/client/localize-relative";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("inbox composer and management dialogs i18n", () => {
  it("keeps translation keys identical in both catalogs", () => {
    for (const group of ["InboxComposer", "InboxDialogs"] as const) {
      expect(Object.keys(pt[group]).sort()).toEqual(Object.keys(en[group]).sort());
    }
  });

  it("localizes sending, draft and attachment safeguards", () => {
    expect(br("InboxComposer.savedReplies")).toBe("Respostas salvas");
    expect(br("InboxComposer.fileTooBig", {name: "proposta.pdf", max: 10})).toContain("proposta.pdf");
    expect(br("InboxComposer.linkedinMax", {count: 9000, max: 8000})).toContain("8.000");
    expect(br("InboxComposer.draftSaved", {time: "há 2 min."})).toContain("Rascunho salvo");
    expect(br("InboxComposer.sendSnooze")).toContain("adiar");
    expect(br("InboxComposer.insertBooking", {url: "cal.com/empresa"})).toContain("cal.com/empresa");
    expect(english("InboxComposer.sendReply")).toBe("Send reply");
  });

  it("localizes tags, saved replies, views and linking warnings", () => {
    expect(br("InboxDialogs.conversationCount", {count: 2})).toContain("2 conversas");
    expect(br("InboxDialogs.deleteTagBody", {count: 1})).toContain("1 conversa");
    expect(br("InboxDialogs.deleteSavedReplyTitle", {name: "Apresentação"})).toContain("Apresentação");
    expect(br("InboxDialogs.savedViewNotice", {name: "Prioridades"})).toContain("Prioridades");
    expect(br("InboxDialogs.missingAddress", {address: "teste@empresa.com"})).toContain("teste@empresa.com");
    expect(br("InboxDialogs.indigo")).toBe("Índigo");
    expect(english("InboxDialogs.linkToContact")).toBe("Link to a contact");
  });

  it("formats relative dates in pt-BR without changing English defaults", () => {
    const now = new Date("2026-10-31T20:00:00Z");
    expect(formatRelativeByLocale("2026-10-31T19:58:00Z", "pt-BR", now)).toContain("2");
    expect(formatRelativeByLocale("2026-10-31T19:58:00Z", "en", now)).toBe("2 min ago");
    expect(formatRelativeByLocale(null, "pt-BR", now)).toBe("—");
  });
});
