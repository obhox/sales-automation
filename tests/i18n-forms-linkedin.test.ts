import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {numberProblem} from "../components/linkedin-accounts/SettingsFields";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});

describe("list and LinkedIn form localization", () => {
  it("translates list forms, imports, synchronization and contact movements", () => {
    expect(br("ListDialogs.new")).toBe("Nova lista");
    expect(br("ListDialogs.queued")).toContain("fila");
    expect(br("ListDialogs.cancelTitle", {name: "Leads"})).toContain("Leads");
    expect(br("ListDialogs.moved", {count: 4, name: "Clientes"})).toContain("Clientes");
    expect(english("ListDialogs.move")).toBe("Move");
  });

  it("localizes LinkedIn connection instructions and verification flow", () => {
    expect(br("LinkedinConnect.connectTitle")).toBe("Conectar nova conta");
    expect(br("LinkedinConnect.reconnectTitle", {name: "Comercial"})).toContain("Comercial");
    expect(br("LinkedinConnect.serverLoginHint", {route: "pelo proxy"})).toContain("proxy");
    expect(br("LinkedinConnect.sessionHeld", {remaining: "00:59"})).toContain("00:59");
    expect(br("LinkedinConnect.verifyConnect")).toBe("Verificar e conectar");
    expect(english("LinkedinConnect.passwordHint")).toContain("not stored");
  });

  it("translates working hours and days without altering the underlying validation", () => {
    expect(br("LinkedinSettings.workingDays")).toBe("Dias de funcionamento");
    expect(br("LinkedinSettings.short.mon")).toBe("Seg");
    expect(br("LinkedinSettings.range", {min: 1, max: 100})).toContain("100");
    expect(numberProblem("", 1, 100, false)).toBe("Required");
    expect(numberProblem("101", 1, 100, false)).toBe("From 1 to 100");
  });

  it("translates non-sending diagnostics, account removal and preset limits", () => {
    expect(br("LinkedinAccountDialogs.outcomes.pending")).toBe("Convite pendente");
    expect(br("LinkedinAccountDialogs.deleteHelp", {name: "Vendas"})).toContain("Vendas");
    expect(br("LinkedinPreset.savedApplied", {count: 3})).toContain("3 contas");
    expect(br("LinkedinPreset.rampTooHigh")).toContain("limite diário");
    expect(english("LinkedinPreset.warmup")).toBe("Warm-up");
  });
});
