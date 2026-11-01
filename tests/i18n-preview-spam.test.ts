import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {checkSpam} from "../lib/email/spam-check";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("sequence preview and spam translations", () => {
  it("renders the main confirmation and test-send labels", () => {
    expect(br("SequenceDialogs.previewTitle")).toBe("Visualizar como contato");
    expect(br("SequenceDialogs.safeEmailTest")).toContain("[Test]");
    expect(br("SequenceDialogs.testSent", {address: "test@example.com"})).toContain("test@example.com");
    expect(english("SequenceDialogs.writeSample")).toBe("Generate a sample");
  });

  it("translates all known spam scanning reasons without changing scanning results", () => {
    const findings = checkSpam({subject: "URGENT: BUY NOW!!!", body: "CLICK HERE, absolutely free"}).findings;
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(br.has(`SpamCheck.rules.${finding.rule}`)).toBe(true);
      expect(br(`SpamCheck.rules.${finding.rule}`).length).toBeGreaterThan(8);
    }
  });

  it("keeps spam modes and warnings in sync between locales", () => {
    for (const mode of ["off", "flag", "remove"]) {
      expect(br(`SpamCheck.modes.${mode}`).length).toBeGreaterThan(0);
      expect(english(`SpamCheck.modes.${mode}`).length).toBeGreaterThan(0);
    }
    expect(br("SpamCheck.flagged", {count: 3, level: "Alto risco"})).toContain("3");
    expect(br("SpamCheck.cleanButton")).toContain("Remover");
  });
});
