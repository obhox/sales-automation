import {describe, expect, it} from "vitest";
import {IntlMessageFormat} from "intl-messageformat";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

type Dict = Record<string, string | Dict>;
function flatten(obj: Dict, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? prefix + "." + key : key;
    if (typeof value === "string") result[path] = value;
    else Object.assign(result, flatten(value, path));
  }
  return result;
}

describe("complete i18n translation and integrity audit", () => {
  const english = flatten(en as Dict);
  const portuguese = flatten(pt as Dict);

  it("preserves all translation keys on both catalogs", () => {
    expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(portuguese).length).toBeGreaterThan(5000);
  });

  it("has nonempty translations and valid ICU syntax in both languages", () => {
    for (const [key, msg] of Object.entries(english)) {
      expect(msg.trim(), key + " en").not.toBe("");
      expect(portuguese[key]?.trim(), key + " pt-BR").not.toBe("");
      expect(() => new IntlMessageFormat(msg, "en"), key + " en").not.toThrow();
      expect(() => new IntlMessageFormat(portuguese[key], "pt-BR"), key + " pt-BR").not.toThrow();
    }
  }, 90000);

  it("translates the public landing page including alt descriptions and SEO metadata", () => {
    const ns = pt.WelcomePage;
    expect(ns.heroTitle).toContain("LinkedIn e e-mail");
    expect(ns.sec_sequences_title).toContain("Dois canais");
    expect(ns.sec_reporting_alt1).toContain("Funil");
    expect(ns.metaDescription).toContain("seu próprio servidor");
    expect(Object.keys(ns).length).toBeGreaterThanOrEqual(108);
    expect(Object.keys(ns).sort()).toEqual(Object.keys(en.WelcomePage).sort());
    for (const key of Object.keys(ns)) {
      expect(ns[key as keyof typeof ns].trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps public routes, external integrations and campaign identifiers unchanged", () => {
    const source = [
      "components/integrations/ConnectDialog.tsx",
      "components/linkedin-accounts/EditAccountDrawer.tsx",
      "components/companies/CompanyDialogs.tsx",
      "pages/oauth/authorize.tsx",
      "pages/r/[token].tsx",
    ].map(file => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    expect(source).toContain("CONNECTIONS_PATH");
    expect(source).toContain("daily_connection_limit");
    expect(source).toContain("COMPANY_ENRICH_PATH");
    expect(source).toContain('action="/api/oauth/authorize"');
    expect(source).toContain("openShare");
  });

  it("uses namespaces on shared controls and remaining screen components", () => {
    const paths = [
      "components/admin/AdminScreen.tsx",
      "components/integrations/ConnectDialog.tsx",
      "components/linkedin-accounts/EditAccountDrawer.tsx",
      "components/ui/Charts.tsx",
      "components/ui/Input.tsx",
      "components/ui/Steps.tsx",
      "components/ui/DataTable.tsx",
      "components/ui/States.tsx",
      "components/ui/Dialog.tsx",
      "components/ui/Alert.tsx",
      "components/ui/Spinner.tsx",
      "components/welcome/WelcomePage.tsx",
      "pages/invite/[token].tsx",
      "pages/verify-email.tsx",
      "pages/oauth/authorize.tsx",
      "pages/r/[token].tsx",
    ];
    for (const file of paths) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toMatch(/useTranslations|useUiCommonTranslations|useWelcomeTranslations/);
    }
  });
});
