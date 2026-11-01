import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import {formatAgeByLocale, formatDateTimeByLocale} from "../lib/client/localize-relative";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("remaining inbox panels pt-BR and en", () => {
  it("keeps English/Portuguese catalog keys synchronized", () => {
    for (const group of ["InboxConversationList", "InboxFilterRail", "InboxMessages", "InboxThreadHeader", "InboxThreadPane"] as const) {
      expect(Object.keys(pt[group]).sort()).toEqual(Object.keys(en[group]).sort());
    }
  });

  it("localizes conversation list without changing filter values", () => {
    expect(br("InboxConversationList.threadCount", {count: 2})).toContain("2 conversas");
    expect(br("InboxConversationList.pagination", {first: 1, last: 20, total: 1250})).toContain("1.250");
    expect(br("InboxConversationList.assigned", {name: "Ana"})).toContain("Ana");
    expect(br("InboxConversationList.repliedLinkedin")).toContain("LinkedIn");
    expect(english("InboxConversationList.nothingMatches")).toBe("Nothing matches");
  });

  it("localizes inbox filters, verdict, sentiment and SLA", () => {
    expect(br("InboxFilterRail.verdict")).toBe("Classificação");
    expect(br("InboxFilterRail.humanReview")).toBe("Precisa de análise");
    expect(br("InboxFilterRail.unassigned")).toBe("Sem responsável");
    expect(br("InboxFilterRail.dueToday")).toBe("Vencem hoje");
    expect(english("InboxFilterRail.reset")).toBe("Reset");
  });

  it("localizes thread message actions and confirmation notices", () => {
    expect(br("InboxMessages.sendAgain")).toBe("Enviar novamente");
    expect(br("InboxMessages.confirmRetryBody")).toContain("LinkedIn");
    expect(br("InboxMessages.followup", {due: br("InboxMessages.followupDue", {date: "01/11"})})).toContain("01/11");
    expect(br("InboxMessages.earlier", {count: 3})).toContain("3 mensagens anteriores");
    expect(br("InboxMessages.markedVerdict", {verdict: "positiva"})).toContain("positiva");
    expect(br("InboxMessages.dispatchSuppressed")).toContain("não contatar");
    expect(br("InboxMessages.suggestedStep", {action: br("InboxMessages.stepHuman")})).toContain("responder pessoalmente");
  });

  it("localizes triage controls without altering API status keys", () => {
    expect(br("InboxThreadHeader.statusAria", {value: br("InboxThreadHeader.closed")})).toContain("Encerrada");
    expect(br("InboxThreadHeader.markAs", {verdict: "negativa"})).toContain("negativa");
    expect(br("InboxThreadHeader.dueIn", {duration: "2h"})).toContain("2h");
    expect(br("InboxThreadHeader.untilDate", {date: "01 nov."})).toContain("01 nov.");
    expect(br("InboxThreadPane.unsubscribeTitle", {name: "Empresa Exemplo"})).toContain("Empresa Exemplo");
    expect(br("InboxThreadPane.queuedEmail")).toContain("servidor de e-mail");
    expect(english("InboxThreadPane.sent")).toBe("Sent");
  });

  it("formats conversation dates in Portuguese without changing English", () => {
    const now = new Date("2026-10-31T13:00:00Z");
    expect(formatAgeByLocale("2026-10-31T12:50:00Z", "pt-BR", now)).toBe("10 min");
    expect(formatAgeByLocale("2026-10-31T12:50:00Z", "en", now)).toBe("10m");
    expect(formatDateTimeByLocale("2026-10-31T12:50:00Z", "pt-BR", now)).toContain("Hoje");
    expect(formatDateTimeByLocale("2026-10-31T12:50:00Z", "en", now)).toContain("Today");
  });
});
