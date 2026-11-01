import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("list details and LinkedIn account cards", () => {
  it("translates list actions, filters and warnings", () => {
    expect(br("ListDetail.lists")).toBe("Listas");
    expect(br("ListDetail.deleteTitle", {name: "Leads"})).toContain("Leads");
    expect(br("ListDetail.removeCountTitle", {count: 9})).toContain("9 contatos");
    expect(br("ListDetail.filterFields.enriched")).toBe("Enriquecimento");
    expect(br("ListDetail.campaignProgress", {finished: 3, total: 10, date: "10/2026"})).toContain("3 de 10");
    expect(english("ListDetail.noMatch")).toContain("No matching");
  });

  it("translates session, invitation and safety actions on account cards", () => {
    expect(br("LinkedinAccountCard.sessionHealthy")).toBe("Sessão ativa");
    expect(br("LinkedinAccountCard.warmingDay", {day: 2, total: 14})).toContain("dia 2 de 14");
    expect(br("LinkedinAccountCard.withdrawManual", {days: 21, count: 5})).toContain("21 dias");
    expect(br("LinkedinAccountCard.weekdayLetter.sun")).toBe("D");
    expect(english("LinkedinAccountCard.checkSession")).toBe("Check session");
  });
});
