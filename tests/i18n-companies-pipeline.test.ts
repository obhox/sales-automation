import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {FILTER_OPTIONS, SORT_OPTIONS} from "../components/companies/model";
import {VIEWS} from "../components/pipeline/model";

const br = createTranslator({locale:"pt-BR", messages:pt});
const english = createTranslator({locale:"en", messages:en});

describe("company and pipeline localization", () => {
  it("translates company search, filtering and irreversible actions", () => {
    expect(br("Companies.title")).toBe("Empresas");
    expect(br("Companies.deleteTitle", {name:"Exemplo"})).toContain("Exemplo");
    expect(br("Companies.deleteBody", {contacts:br("Companies.deleteContacts", {count:8})})).toContain("8 contatos");
    expect(br("Companies.handledSignals", {count:2})).toContain("2");
    expect(english("Companies.noMatch")).toBe("No matching companies");
  });

  it("preserves backend filter and sort identifiers", () => {
    for (const option of FILTER_OPTIONS) {
      expect(br.has(`Companies.filter.${option.value}`)).toBe(true);
      expect(english.has(`Companies.filter.${option.value}`)).toBe(true);
    }
    for (const option of SORT_OPTIONS) {
      const key = option.value.replace(":", "_");
      expect(br.has(`Companies.sort.${key}`)).toBe(true);
      expect(english.has(`Companies.sort.${key}`)).toBe(true);
    }
  });

  it("translates company detail and CSV import safeguards", () => {
    expect(br("CompanyDialogs.target")).toContain("Empresa-alvo");
    expect(br("CompanyDialogs.importRule")).toContain("não serão sobrescritos");
    expect(br("CompanyDialogs.importRows", {count:150})).toContain("150");
    expect(br("CompanyDetail.signals")).toBe("Sinais da empresa");
    expect(br("CompanyDetail.showAll", {shown:6, total:" de 20"})).toContain("6 de 20");
  });

  it("preserves pipeline view values while translating visible labels", () => {
    for (const view of VIEWS) {
      expect(br.has(`Pipeline.views.${view.value}`)).toBe(true);
      expect(english.has(`Pipeline.views.${view.value}`)).toBe(true);
    }
    expect(br("Pipeline.views.board")).toBe("Quadro");
    expect(br("Pipeline.views.meetings")).toBe("Reuniões");
    expect(br("Pipeline.moved", {name:"Negócio", stage:"Proposta"})).toContain("Proposta");
  });

  it("translates opportunity validations, confirmations and board states", () => {
    expect(br("PipelineOpportunity.amountError")).toContain("maior ou igual a zero");
    expect(br("PipelineOpportunity.currencyError")).toContain("três letras");
    expect(br("PipelineOpportunity.deleteTitle", {name:"Contrato"})).toContain("Contrato");
    expect(br("PipelineBoard.noStages")).toContain("não possui etapas");
    expect(br("PipelineBoard.columnLabel", {name:"Proposta", count:5})).toContain("5 oportunidades");
    expect(english("PipelineOpportunity.new")).toBe("New opportunity");
  });
});
