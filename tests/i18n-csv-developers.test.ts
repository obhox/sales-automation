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
  "CsvUpload", "CsvFile", "CsvUnfinished", "CsvImport", "CsvMapping",
  "CsvSidePanel", "CsvStepPanels", "DeveloperMain", "DeveloperParts",
  "DeveloperKeysDialog", "DeveloperWebhookDialog", "DeveloperApiKeys",
  "DeveloperWebhooks", "DeveloperDeliveries", "DeveloperSideCards", "DeveloperReference",
] as const;

describe("CSV import and Developer API i18n", () => {
  it("maintains exactly matching keys in both languages", () => {
    for (const ns of namespaces) {
      expect(Object.keys(pt[ns]).sort()).toEqual(Object.keys(en[ns]).sort());
    }
  });
  it("compiles every new message as ICU, in both languages", () => {
    for (const ns of namespaces) {
      for (const [key, value] of Object.entries(en[ns])) {
        expect(() => new IntlMessageFormat(value, "en"), "en:" + ns + "." + key).not.toThrow();
        expect(() => new IntlMessageFormat((pt[ns] as Record<string, string>)[key], "pt-BR"), "pt:" + ns + "." + key).not.toThrow();
      }
    }
  });
  it("localizes CSV selection, validation and resume", () => {
    expect(br("CsvUpload.chooseFile")).toBe("Selecionar arquivo CSV");
    expect(br("CsvImport.stepMeta", {current: 2, total: 4, name: "Mapear colunas"})).toContain("Etapa 2 de 4");
    expect(br("CsvUnfinished.draftMany", {count: 3})).toContain("3 importações");
    expect(br("CsvFile.previewDescription", {shown: 5, total: 2000, name: "leads.csv"})).toContain("leads.csv");
  });
  it("localizes CSV columns and matching without changing technical identifiers", () => {
    expect(br("CsvMapping.stdLinkedin")).toBe("Perfil LinkedIn");
    expect(br("CsvMapping.summary", {mapped: 7, total: 10, newFields: ""})).toContain("7 de 10");
    expect(br("CsvSidePanel.listBeforeAfter", {before: 100, after: 120})).toContain("120");
    expect(br("CsvSidePanel.matches", {count: 2})).toContain("2 correspondências");
  });
  it("localizes import previews and result counts", () => {
    expect(br("CsvStepPanels.reviewCreate", {count: 1})).toContain("novo contato");
    expect(br("CsvStepPanels.importRows", {count: 50})).toContain("50 linhas");
    expect(br("CsvStepPanels.errors", {count: 2})).toContain("2 linhas");
    expect(english("CsvStepPanels.noDuplicates")).toBe("No duplicates");
  });
  it("localizes API scope and validation with the API scope tokens intact", () => {
    expect(br("DeveloperKeysDialog.scope_contacts_read")).toBe("Ler contatos");
    expect(br("DeveloperKeysDialog.detail_mcp_execute")).toContain("envios");
    expect(br("DeveloperKeysDialog.limitError", {limit: 100000})).toContain("100.000");
    expect(br("DeveloperApiKeys.revokeTitle", {name: "Integração CRM"})).toContain("CRM");
    expect(english("DeveloperKeysDialog.createTitle")).toBe("Create an API key");
  });
  it("localizes webhook confirmations, events and failure queue", () => {
    expect(br("DeveloperWebhookDialog.invalidUrl")).toContain("https://");
    expect(br("DeveloperWebhooks.pauseBody")).toContain("não serão entregues");
    expect(br("DeveloperWebhooks.deadCount", {count: 3})).toContain("3 entregas");
    expect(br("DeveloperDeliveries.attemptCount", {count: 8})).toContain("8 tentativas");
    expect(br("DeveloperDeliveries.answered", {code: 200})).toContain("HTTP 200");
  });
  it("localizes MCP, workspace integrations and API reference", () => {
    expect(br("DeveloperSideCards.mcpTitle")).toBe("Servidor MCP");
    expect(br("DeveloperSideCards.uptime", {hours: 2, minutes: 30})).toContain("2h 30min");
    expect(br("DeveloperReference.endpoint_sendContact")).toContain("409");
    expect(br("DeveloperReference.title")).toBe("Referência da API");
    expect(br("DeveloperReference.meta", {count: 34, version: "1"})).toContain("versão 1");
  });
  it("preserves API routes, scope identifiers, HMAC headers and CSV import state", () => {
    const contents = [
      "csv-import/ImportScreen.tsx", "csv-import/MappingCard.tsx",
      "developers/KeyDialogs.tsx", "developers/WebhookDialog.tsx", "developers/ReferenceScreen.tsx",
    ].map((f) => readFileSync(join(process.cwd(), "components", f), "utf8")).join("\n");
    expect(contents).toContain("runPath(draft.id)");
    expect(contents).toContain("contacts:read");
    expect(contents).toContain("hmac_sha256");
    expect(contents).toContain("WEBHOOKS_PATH");
  });
});
