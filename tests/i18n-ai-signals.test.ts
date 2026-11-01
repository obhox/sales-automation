import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import {IntlMessageFormat} from "intl-messageformat";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});
const namespaces = [
  "AiScreen", "AiModelSelect", "AiProvider", "AiSpend", "AiWritingStyle", "AiSteps", "AiTest",
  "SignalsMain", "SignalsPicker", "SignalsRecord", "SignalsFeed", "SignalsRules", "SignalsDetection",
] as const;

describe("AI and Signals pt-BR frontend i18n", () => {
  it("has one-to-one catalog parity across the new screen namespaces", () => {
    for (const ns of namespaces) {
      expect(Object.keys(pt[ns]).sort(), ns).toEqual(Object.keys(en[ns]).sort());
    }
  });
  it("compiles every English and Portuguese message as ICU", () => {
    for (const ns of namespaces) {
      for (const [key, value] of Object.entries(en[ns])) {
        expect(() => new IntlMessageFormat(value, "en"), "en:" + ns + "." + key).not.toThrow();
        expect(() => new IntlMessageFormat((pt[ns] as Record<string, string>)[key], "pt-BR"), "pt:" + ns + "." + key).not.toThrow();
      }
    }
  });
  it("localizes AI provider, model selection, and security warnings", () => {
    expect(br("AiScreen.title")).toBe("IA e modelos");
    expect(br("AiProvider.rotate")).toBe("Trocar chave");
    expect(br("AiProvider.rotateHint")).toContain("Revogue");
    expect(br("AiModelSelect.pricing")).toContain("milhão de tokens");
    expect(english("AiProvider.apiKey")).toBe("API key");
  });
  it("handles budget monetary limits and pluralization", () => {
    expect(br("AiSpend.monthlyBudget")).toBe("Orçamento mensal");
    expect(br("AiSpend.budgetReached", {date: "30 nov"})).toContain("30 nov");
    expect(br("AiSpend.requests", {count: 1})).toBe("1 requisição");
    expect(br("AiSpend.requests", {count: 5})).toBe("5 requisições");
  });
  it("localizes style tone and step settings without translating technical values", () => {
    expect(br("AiWritingStyle.formal")).toBe("Formal");
    expect(br("AiWritingStyle.noteDirect")).toContain("direto ao ponto");
    expect(br("AiSteps.langPortuguese")).toBe("Português");
    expect(br("AiSteps.workspaceDefault")).toContain("espaço");
    expect(br("AiSteps.wordsError", {max: 200})).toContain("200");
  });
  it("localizes the AI paid test and clearly states it does not send to a contact", () => {
    expect(br("AiTest.desc")).toContain("Nada será enviado");
    expect(br("AiTest.costHint")).toContain("cobrada");
    expect(br("AiTest.resultFor", {channel: "E-mail", name: "Contato A"})).toContain("Contato A");
    expect(br("AiTest.tokens", {input: 1200, output: 300, cost: "$0.03"})).toContain("1.200");
  });
  it("localizes the signals feed and source labels", () => {
    expect(br("SignalsMain.title")).toBe("Sinais");
    expect(br("SignalsMain.summary", {newCount: 3, total: 25})).toContain("3 novos");
    expect(br("SignalsFeed.job")).toBe("Mudança de cargo");
    expect(br("SignalsFeed.markedCount", {count: 2})).toContain("2 sinais");
    expect(br("SignalsPicker.noMatches", {query: "Acme"})).toContain("Acme");
  });
  it("localizes signal creation and preserves signal payload types", () => {
    expect(br("SignalsRecord.aboutRequired")).toContain("Selecione");
    expect(br("SignalsRecord.companyHint")).toContain("Regras");
    expect(br("SignalsRecord.funding")).toBe("Investimento");
    expect(br("SignalsRecord.scoreInvalid")).toContain("0 a 100");
  });
  it("localizes automated rules and destructive confirmations", () => {
    expect(br("SignalsRules.deleteTitle", {name: "Regra 1"})).toContain("Regra 1");
    expect(br("SignalsRules.deleteHelp")).toContain("permanecerão");
    expect(br("SignalsRules.missingList")).toContain("lista");
    expect(br("SignalsRules.thenWait")).toContain("manual");
  });
  it("localizes paid Apollo detection warnings and usage", () => {
    expect(br("SignalsDetection.runTitle")).toContain("Verificar");
    expect(br("SignalsDetection.runBody", {account: "10 empresas", credits: 20})).toContain("20 créditos");
    expect(br("SignalsDetection.costRun", {count: 3, each: 2, total: 6})).toContain("6 créditos");
    expect(br("SignalsDetection.costNoCap")).toContain("desativada");
    expect(br("SignalsDetection.addedCount", {count: 2})).toContain("2 empresas");
  });
  it("leaves API endpoints, model IDs, signal type tokens and credit configuration unchanged", () => {
    const files = [
      "ai/ProviderCard.tsx", "ai/TestDialog.tsx", "ai/StepSettingsCard.tsx",
      "signals/RecordSignalDialog.tsx", "signals/RulesTab.tsx", "signals/DetectionTab.tsx",
    ];
    const source = files.map((f) => readFileSync(join(process.cwd(), "components", f), "utf8")).join("\n");
    expect(source).toContain('"/api/integrations"');
    expect(source).toContain('"openrouter"');
    expect(source).toContain("ai_enabled");
    expect(source).toContain("SIGNAL_TYPES");
    expect(source).toContain('action: "run"');
    expect(source).toContain("monthly_credit_cap");
  });
});
