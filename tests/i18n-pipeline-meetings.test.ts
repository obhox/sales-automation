import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale:"pt-BR", messages:pt});
const english = createTranslator({locale:"en", messages:en});

describe("meetings and calendars localization", () => {
  it("translates meeting filters and linking to contacts", () => {
    expect(br("PipelineMeetings.title")).toBe("Reuniões");
    expect(br("PipelineMeetings.timeOptions.upcoming")).toBe("Próximas");
    expect(br("PipelineMeetings.timeOptions.past")).toBe("Anteriores");
    expect(br("PipelineMeetings.unmatched")).toBe("Sem associação");
    expect(br("PipelineMeetings.linked", {name:"Contato"})).toContain("Contato");
    expect(english("PipelineMeetings.linkTo")).toBe("Link to a contact");
  });
  it("preserves calendar deletion warnings, remote URL privacy and provider labels", () => {
    expect(br("PipelineMeetings.removeTitle", {name:"Agenda Comercial"})).toContain("Agenda Comercial");
    expect(br("PipelineMeetings.removeWarning")).toContain("preservadas");
    expect(br("PipelineMeetings.feedHelp")).toContain("Qualquer pessoa");
    expect(br("PipelineMeetings.feedUrlError")).toContain("https://");
    expect(br("PipelineMeetings.google")).toBe("Entrar com Google");
    expect(br("PipelineMeetings.microsoft")).toBe("Entrar com Microsoft");
  });
});
