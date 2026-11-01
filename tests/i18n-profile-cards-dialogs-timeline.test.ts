import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("contact profile cards, dialogs and timeline localization", () => {
  it("keeps new catalogs synchronized", () => {
    for (const group of ["ContactProfileCards", "ContactProfileDialogs", "ContactTimeline"] as const) {
      expect(Object.keys(pt[group]).sort()).toEqual(Object.keys(en[group]).sort());
    }
  });

  it("localizes contact cards and dynamic values", () => {
    expect(br("ContactProfileCards.details")).toBe("Detalhes");
    expect(br("ContactProfileCards.others", {count: 2})).toContain("2 outros contatos");
    expect(br("ContactProfileCards.copied", {what: "Endereço de e-mail"})).toContain("copiado");
    expect(br("ContactProfileCards.doneCount", {count: 3})).toContain("3 concluídas");
    expect(english("ContactProfileCards.other" + "s", {count: 1})).toContain("1 other contact");
  });

  it("localizes forms without changing provider labels or field keys", () => {
    expect(br("ContactProfileDialogs.fieldTimeZone")).toBe("Fuso horário");
    expect(br("ContactProfileDialogs.activityLogged")).toBe("Atividade registrada");
    expect(br("ContactProfileDialogs.typeCall")).toBe("Ligação");
    expect(br("ContactProfileDialogs.messageQueued")).toBe("Mensagem colocada na fila");
    expect(br("ContactProfileDialogs.emailSent", {email: "contato@exemplo.com"})).toContain("contato@exemplo.com");
    expect(english("ContactProfileDialogs.sendEmail")).toBe("Send email");
  });

  it("localizes timeline controls, filters and empty states", () => {
    expect(br("ContactTimeline.outreachTimeline")).toBe("Histórico de interações");
    expect(br("ContactTimeline.showEarlier", {count: 5})).toContain("5 anteriores");
    expect(br("ContactTimeline.emptyEmail")).toContain("e-mail");
    expect(br("ContactTimeline.stepTitle", {step: 2, action: "Convite enviado"})).toContain("Etapa 2");
    expect(br("ContactTimeline.linkClicks", {count: 3})).toContain("3 cliques");
    expect(br("ContactTimeline.addedToList", {name: "Prospects"})).toContain("Prospects");
    expect(br("ContactTimeline.repliedEmail")).toBe("Resposta por e-mail");
    expect(english("ContactTimeline.showFull")).toBe("Show full message");
  });
});
