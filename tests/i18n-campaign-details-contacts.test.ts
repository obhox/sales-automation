import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});
const namespaces = [
  "ContactCells", "ContactManagement", "ContactSavedViews", "CampaignDetailDialogs",
  "CampaignOverview", "CampaignOverviewCards", "CampaignProspects", "CampaignSettings",
] as const;

describe("campaign details and contacts i18n", () => {
  it("keeps keys synchronized between Portuguese and English in all eight components", () => {
    for (const namespace of namespaces) {
      expect(Object.keys(pt[namespace]).sort()).toEqual(Object.keys(en[namespace]).sort());
    }
  });

  it("translates email verification and contact table actions", () => {
    expect(br("ContactCells.emailVerified")).toContain("Verificado");
    expect(br("ContactCells.emailCatchall")).toContain("catch-all");
    expect(br("ContactCells.actionsFor", {name: "Ana"})).toContain("Ana");
    expect(br("ContactCells.openLinkedin")).toBe("Abrir no LinkedIn");
    expect(english("ContactCells.openProfile")).toBe("Open profile");
  });

  it("translates destructive contact tag and field confirmations with ICU plural", () => {
    expect(br("ContactManagement.deleteTagCount", {count: 1})).toContain("1 contato");
    expect(br("ContactManagement.deleteTagCount", {count: 5})).toContain("5 contatos");
    expect(br("ContactManagement.deleteFieldBody", {count: 2, key: "{{renewal_date}}"})).toContain("renewal_date");
    expect(br("ContactManagement.typeBoolean")).toBe("Sim / não");
    expect(br("ContactManagement.deleteTagTitle", {name: "Prioritário"})).toContain("Prioritário");
  });

  it("translates saved view permission and deletion warnings", () => {
    expect(br("ContactSavedViews.deleteTitle", {name: "Minha visão"})).toContain("Minha visão");
    expect(br("ContactSavedViews.shareHint")).toContain("gerente");
    expect(br("ContactSavedViews.viewSaved", {name: "Quentes"})).toContain("Quentes");
    expect(english("ContactSavedViews.updateView")).toBe("Update view");
  });

  it("translates campaign participant enrollment and share safeguards", () => {
    expect(br("CampaignDetailDialogs.enrolCount", {count: 1})).toContain("1 contato");
    expect(br("CampaignDetailDialogs.enrolCount", {count: 4})).toContain("4 contatos");
    expect(br("CampaignDetailDialogs.revokeTitle", {hint: "ABC"})).toContain("ABC");
    expect(br("CampaignDetailDialogs.liveLinks", {count: 2})).toContain("2 links ativos");
    expect(br("CampaignDetailDialogs.enrolledSuccess", {count: 3})).toContain("3 contatos inscritos");
    expect(br("CampaignDetailDialogs.shareActivity", {creator: "Ana", views: "aberto 2 vezes"})).toContain("Ana");
  });

  it("translates campaign overview and period controls", () => {
    expect(br("CampaignOverview.promoteTitle", {label: "B", number: 2})).toContain("versão B");
    expect(br("CampaignOverview.updated", {relative: "há 2 minutos"})).toContain("há 2 minutos");
    expect(br("CampaignOverview.rangeAll")).toContain("período");
    expect(br("CampaignOverviewCards.kpi_reply")).toBe("Taxa de respostas");
    expect(br("CampaignOverviewCards.basis_reply", {part: 10, whole: 50})).toContain("10 de 50");
  });

  it("translates A/B confidence, conversion, and open-tracking explanations", () => {
    expect(br("CampaignOverviewCards.variantSubtitle", {number: 2, count: 3, split: ""})).toContain("3 versões");
    expect(br("CampaignOverviewCards.confidenceSignificant", {percent: 97})).toContain("97%");
    expect(br("CampaignOverviewCards.moreSends", {count: 1250, auto: ""})).toContain("1.250");
    expect(br("CampaignOverviewCards.opensNote")).toContain("A/B");
    expect(english("CampaignOverviewCards.status_winner")).toBe("Winner");
  });

  it("translates campaign prospect statuses, log, and removal warnings", () => {
    expect(br("CampaignProspects.status_held")).toBe("Em espera");
    expect(br("CampaignProspects.retried", {count: 2})).toContain("2 participantes");
    expect(br("CampaignProspects.noneRemove")).toContain("Nenhum");
    expect(br("CampaignProspects.unenrolTitle", {people: "Ana"})).toContain("Ana");
    expect(br("CampaignProspects.showing", {shown: 20, total: 1250})).toContain("1.250");
    expect(br("CampaignProspects.missing")).toContain("não existe");
  });

  it("translates campaign settings, email tracking, and archive/delete confirmations", () => {
    expect(br("CampaignSettings.deleteTitle", {name: "Campanha X"})).toContain("Campanha X");
    expect(br("CampaignSettings.deleteWithPeople", {count: 2, inFlight: 1})).toContain("2 inscrições");
    expect(br("CampaignSettings.inFlightNotice", {count: 3})).toContain("3 contatos");
    expect(br("CampaignSettings.trackOpens", {number: 2})).toContain("e-mail 2");
    expect(br("CampaignSettings.spamFlagHint")).toContain("sem alteração");
    expect(english("CampaignSettings.saveChanges")).toBe("Save changes");
  });
});
