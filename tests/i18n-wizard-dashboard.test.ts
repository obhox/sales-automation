import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("dashboard and campaign wizard translations", () => {
  it("resolves dashboard labels and chart stages in both languages", () => {
    expect(br("Dashboard.title")).toBe("Painel");
    expect(br("Dashboard.stages.email.delivered")).toBe("Entregues");
    expect(english("Dashboard.title")).toBe("Dashboard");
    expect(br("Dashboard.setup.progress", {done: 2, total: 4})).toContain("2 de 4");
  });

  it("resolves all wizard steps in both languages", () => {
    const steps = ["list", "context", "linkedin", "email", "senders", "summary"] as const;
    for (const step of steps) {
      expect(br(`CampaignWizard.steps.${step}.title`).length).toBeGreaterThan(0);
      expect(english(`CampaignWizard.steps.${step}.title`).length).toBeGreaterThan(0);
    }
    expect(br("CampaignWizard.stepProgress", {current: 2, total: 6, name: "Contexto de IA"})).toContain("Etapa 2 de 6");
  });

  it("handles ICU plurals and campaign review warnings", () => {
    expect(br("CampaignSummary.blocked", {count: 1})).toContain("Um problema");
    expect(br("CampaignSummary.blocked", {count: 3})).toContain("3 problemas");
    expect(br("CampaignSummary.stepCount", {count: 2})).toBe("2 etapas");
    expect(english("CampaignSummary.stepCount", {count: 1})).toBe("1 step");
  });

  it("keeps user-visible confirmations in Portuguese", () => {
    expect(br("CampaignWizard.draftSaved")).toBe("Rascunho salvo");
    expect(br("CampaignSendersStep.status.paused")).toBe("Pausada");
    expect(br("CampaignListStep.excludeCustomers")).toBe("Não incluir clientes");
  });
});
