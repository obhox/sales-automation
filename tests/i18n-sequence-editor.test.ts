import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("sequence editor localization", () => {
  it("translates workflow actions and confirmations without changing their meaning", () => {
    expect(br("Sequence.save")).toBe("Salvar sequência");
    expect(br("Sequence.deleteTitle")).toBe("Excluir esta etapa?");
    expect(br("Sequence.saveWithContacts", {count: "15"})).toContain("15 contatos");
    expect(br("Sequence.movedContacts", {count: "3", moved: ""})).toContain("3 contatos");
    expect(english("Sequence.discardTitle")).toBe("Discard your changes?");
  });

  it("translates editing, A/B variants and message rewriting", () => {
    expect(br("StepPanel.trackOpens")).toBe("Rastrear aberturas");
    expect(br("StepDelay.waitUnit")).toBe("Unidade de espera");
    expect(br("StepVariants.used", {used: 2, max: 5})).toBe("2 de 5 utilizadas");
    expect(br("StepTemplatePool.rotate")).toBe("Alternar modelos por contato");
    expect(br("StepAi.enable")).toBe("Permitir que a IA escreva esta etapa");
    expect(br("MessageEditor.rewritten")).toBe("Texto reescrito");
    expect(english("MessageEditor.styles.more_direct")).toBe("Make it more direct");
  });

  it("preserves stable gate types, operators and action labels in the UI", () => {
    expect(br("SequenceGate.kind.no_reply")).toBe("Sem resposta");
    expect(br("SequenceGate.operators.gte")).toBe("No mínimo");
    expect(br("SequenceGate.sides.connected.yes")).toBe("Se aceitar");
    expect(br("SequenceLane.startOnHandover")).toBe("Quando o LinkedIn encaminhar");
    expect(english("SequenceGate.conditionRow.field")).toBe("What to check");
  });

  it("resolves interpolation in PT and EN without missing variables", () => {
    for (const tr of [br, english]) {
      expect(tr("StepPanel.version", {letter: "A"})).toContain("A");
      expect(tr("SequenceGate.outcome.action", {label: "Teste"})).toContain("Teste");
      expect(tr("SequenceLane.stepCount", {count: 2})).toContain("2");
      expect(tr("MessageEditor.insert", {label: "first_name"})).toContain("first_name");
      expect(tr("StepPanel.emailSubjectPlaceholder").length).toBeGreaterThan(5);
    }
  });
});
