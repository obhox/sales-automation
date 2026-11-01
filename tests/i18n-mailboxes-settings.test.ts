import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});
const namespaces = ["MailboxConnect","MailboxEdit","MailboxDetail","MailboxDomain","MailboxSignature","MailboxWarmup"] as const;

describe("mailbox configuration frontend pt-BR / en", () => {
  it("has identical keys in both catalogs for all six components", () => {
    for (const name of namespaces) {
      expect(Object.keys(pt[name]).sort()).toEqual(Object.keys(en[name]).sort());
    }
  });

  it("translates SMTP/IMAP connection instructions but keeps protocol names", () => {
    expect(br("MailboxConnect.title")).toBe("Conectar caixa postal");
    expect(br("MailboxConnect.smtpSending")).toContain("SMTP");
    expect(br("MailboxConnect.imapReading")).toContain("IMAP");
    expect(br("MailboxConnect.otherDomain", {domain: "exemplo.com"})).toContain("exemplo.com");
    expect(br("MailboxConnect.selfSignedHint")).toContain("servidor");
    expect(english("MailboxConnect.connect")).toBe("Connect mailbox");
  });

  it("translates editing warnings and email ramp controls", () => {
    expect(br("MailboxEdit.successWithTest", {email: "contato@empresa.com"})).toContain("contato@empresa.com");
    expect(br("MailboxEdit.rampProgress", {status: "Aumentando", day: 5, total: 21})).toContain("dia 5 de 21");
    expect(br("MailboxEdit.warmupPeers", {peers: 2, count: 12})).toContain("12 enviados");
    expect(br("MailboxEdit.health30", {sent: 100, bounces: 2, complaints: 1})).toContain("Últimos 30 dias");
    expect(br("MailboxEdit.rateRange", {min: 0.5, max: 20})).toContain("20%");
  });

  it("translates mailbox DNS state, reputation and statistics", () => {
    expect(br("MailboxDomain.domainMailboxes", {domain: "exemplo.com"})).toContain("exemplo.com");
    expect(br("MailboxDomain.dnsWeak", {record: "DMARC"})).toContain("DMARC");
    expect(br("MailboxDomain.domainMeta", {count: 2, sent: 75, limit: 500})).toContain("2 caixas postais");
    expect(br("MailboxDomain.rampProgress", {status: "Em andamento", day: 3, total: 20})).toContain("dia 3");
    expect(br("MailboxDomain.reputationSpoken", {score: 93})).toContain("93 de 100");
  });

  it("translates test delivery outcomes and queue notices", () => {
    expect(br("MailboxDetail.testSpam", {when: "há 1 min.", tail: ""})).toContain("spam");
    expect(br("MailboxDetail.testInbox", {when: "agora", tail: ""})).toContain("caixa de entrada");
    expect(br("MailboxDetail.testLooking", {when: "agora", recipient: "teste@empresa.com"})).toContain("teste@empresa.com");
    expect(br("MailboxDetail.queueDue", {count: 5, extra: "", next: ""})).toContain("5 previstos hoje");
    expect(br("MailboxDetail.warmupProgress", {state: "Aquecendo", day: 2, total: 21})).toContain("dia 2 de 21");
  });

  it("translates signatures, rotation and pool plurals", () => {
    expect(br("MailboxSignature.saved", {email: "comercial@empresa.com"})).toContain("comercial@empresa.com");
    expect(br("MailboxSignature.firstOnly")).toContain("primeiro e-mail");
    expect(br("MailboxWarmup.poolHint", {count: 1, total: 2})).toContain("1 de 2");
    expect(br("MailboxWarmup.dailySummary", {daily: 5, rate: 40, detail: "aquecimento"})).toContain("5 por dia");
    expect(br("MailboxWarmup.rotationRound")).toBe("Alternada");
    expect(english("MailboxWarmup.rotationRound")).toBe("In turn");
  });

  it("does not translate the stored API protocol and rotation identifiers", () => {
    const connect = readFileSync(join(process.cwd(), "components/mailboxes/ConnectMailboxDialog.tsx"), "utf8");
    const warmup = readFileSync(join(process.cwd(), "components/mailboxes/WarmupSettingsDialog.tsx"), "utf8");
    expect(connect).toContain('security === "ssl"');
    expect(connect).toContain('method === "gmail"');
    expect(warmup).toContain('value: "round_robin"');
    expect(warmup).toContain('value: "capacity"');
  });
});
