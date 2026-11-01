import Link from "next/link";
import { useTranslations } from "next-intl";
import { Page } from "@/components/shell";
import { Card, CodeBlock, Eyebrow, Pill, type Tone } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { Chip } from "./parts";
import { API_VERSION, ENDPOINT_GROUPS, ERRORS, LIST_SHAPE, SIGNATURE, WEBHOOK_BODY, WEBHOOK_EVENTS, curlExample, endpointCount, type Endpoint, type Method } from "./reference";

const METHOD_TONE: Record<Method, Tone> = { GET: "neutral", POST: "good", PATCH: "warn" };

const SECTIONS = [
  { id: "basics", label: "Basics" },
  { id: "errors", label: "Errors and limits" },
  ...ENDPOINT_GROUPS.map((group) => ({ id: group.id, label: group.title })),
  { id: "webhooks", label: "Webhooks" },
  { id: "mcp", label: "MCP server" },
];

function Section({ id, title, about, children }: { id: string; title: string; about?: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="flex scroll-mt-4 flex-col overflow-hidden">
      <div className="flex flex-col gap-0.5 px-3.5 py-[11px]">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{title}</h2>
        {about ? <p className="text-11 text-ink-3">{about}</p> : null}
      </div>
      {children}
    </Card>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded-sm bg-subtle px-1 py-px font-mono text-11 text-ink">{children}</code>;
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const t = useTranslations("DeveloperReference");
  const endpointDescriptions: Record<string, string> = {
    "GET /contacts": t("endpoint_listContacts"),
    "GET /contacts/{id}": t("endpoint_getContact"),
    "POST /contacts": t("endpoint_createContact"),
    "PATCH /contacts/{id}": t("endpoint_updateContact"),
    "POST /contacts/verify": t("endpoint_verifyContacts"),
    "POST /contacts/{id}/send": t("endpoint_sendContact"),
    "GET /suppressions": t("endpoint_listSuppressions"),
    "GET /suppressions/{id}": t("endpoint_getSuppression"),
    "GET /companies": t("endpoint_listCompanies"),
    "GET /companies/{id}": t("endpoint_getCompany"),
    "GET /lists": t("endpoint_listLists"),
    "GET /lists/{id}": t("endpoint_getList"),
    "GET /list_members": t("endpoint_listMembers"),
    "GET /workflows": t("endpoint_listCampaigns"),
    "GET /workflows/{id}": t("endpoint_getCampaign"),
    "GET /runs": t("endpoint_listRuns"),
    "GET /runs/{id}": t("endpoint_getRun"),
    "GET /run_profiles": t("endpoint_runProfiles"),
    "GET /run_profile_tracks": t("endpoint_runTracks"),
    "GET /email_accounts": t("endpoint_mailboxes"),
    "GET /sent_messages": t("endpoint_sentEmails"),
    "GET /sent_messages/{id}": t("endpoint_sentEmail"),
    "GET /events": t("endpoint_listEvents"),
    "POST /events": t("endpoint_reportEvent"),
    "GET /signals": t("endpoint_listSignals"),
    "POST /signals": t("endpoint_createSignal"),
    "GET /signal_rules": t("endpoint_listRules"),
    "GET /signal_rules/{id}": t("endpoint_getRule"),
    "GET /opportunities": t("endpoint_listOpportunities"),
    "GET /opportunities/{id}": t("endpoint_getOpportunity"),
    "POST /opportunities": t("endpoint_createOpportunity"),
    "PATCH /opportunities/{id}": t("endpoint_updateOpportunity"),
    "GET /pipeline_stages": t("endpoint_listStages"),
    "GET /pipeline_stages/{id}": t("endpoint_getStage"),
  };
  return (
    <li className="flex flex-col gap-1.5 border-t border-line px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Pill tone={METHOD_TONE[endpoint.method]} size="sm" className="w-[46px] justify-center font-mono">{endpoint.method}</Pill>
        <span className="font-mono text-12 font-medium text-ink">/api/v1{endpoint.path}</span>
        <Chip mono className="ml-auto">{endpoint.scope}</Chip>
      </div>
      <p className="text-115 leading-[17px] text-ink-2">{endpointDescriptions[endpoint.method + " " + endpoint.path] ?? endpoint.does}</p>
      {endpoint.fields ? (
        <p className="text-105 leading-[16px] text-ink-3">
          {endpoint.method === "GET" ? t("query") : t("body")}
          {endpoint.fields.map((field, index) => {
            const required = /\*/.test(field);
            return (
              <span key={field}>
                {index > 0 ? ", " : ""}
                <span className={cn("font-mono", required ? "font-semibold text-ink-2" : undefined)}>{field.replace("*", "")}</span>
                {required ? <span className="text-ink-2"> {t("required")}</span> : null}
              </span>
            );
          })}
        </p>
      ) : null}
    </li>
  );
}

/** Configure → Developer API → API reference: what the public API offers and how to call it. */
export function ReferenceScreen() {
  const t = useTranslations("DeveloperReference");
  const titleFor = (id: string, fallback: string) => {
    const keys: Record<string, "basics" | "errors" | "webhooks" | "mcp" | "groupContacts" | "groupAudience" | "groupCampaigns" | "groupEvents" | "groupPipeline"> = {
      basics: "basics", errors: "errors", webhooks: "webhooks", mcp: "mcp",
      contacts: "groupContacts", audience: "groupAudience", campaigns: "groupCampaigns",
      events: "groupEvents", pipeline: "groupPipeline",
    };
    return keys[id] ? t(keys[id]) : fallback;
  };
  const aboutFor = (id: string, fallback: string) => {
    const keys: Record<string, "groupContactsAbout" | "groupAudienceAbout" | "groupCampaignsAbout" | "groupEventsAbout" | "groupPipelineAbout"> = {
      contacts: "groupContactsAbout", audience: "groupAudienceAbout", campaigns: "groupCampaignsAbout",
      events: "groupEventsAbout", pipeline: "groupPipelineAbout",
    };
    return keys[id] ? t(keys[id]) : fallback;
  };
  // Rendered after the app has loaded, so the address is this instance's own.
  const origin = typeof window === "undefined" ? "https://your-linki-address" : window.location.origin;

  return (
    <Page title={t("title")} crumbs={[{ label: t("developer"), href: "/developers" }]} meta={<span className="text-11 text-ink-3">{t("meta", {count: endpointCount(), version: API_VERSION})}</span>}>
      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <Section id="basics" title={t("basics")} about={t("basicsAbout")}>
            <div className="flex flex-col gap-3 border-t border-line p-3.5">
              <ul className="flex flex-col gap-2 text-115 leading-[17px] text-ink-2">
                <li><span className="font-semibold text-ink">{t("address")}</span> {t("addressLine")} <Code>{origin}/api/v1</Code>.</li>
                <li><span className="font-semibold text-ink">{t("key")}</span> {t("keyBefore")} <Code>Authorization: Bearer lnk_…</Code> {t("keyAfter")} <Link href="/developers" className="font-semibold text-brand-strong hover:underline">{t("developer")}</Link> {t("keyEnd")}</li>
                <li><span className="font-semibold text-ink">{t("lists")}</span> {t("listStart")} <Code>data</Code> {t("listMiddle")} <Code>pagination</Code>. <Code>limit</Code> {t("listLimit")} <Code>offset</Code> {t("listOffset")}</li>
                <li><span className="font-semibold text-ink">{t("version")}</span> {t("versionEnd")} <Code>X-API-Version: {API_VERSION}</Code>.</li>
                <li><span className="font-semibold text-ink">{t("audit")}</span> {t("auditHint")}</li>
              </ul>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <CodeBlock code={curlExample(origin)} caption={t("firstRequest")} />
                <CodeBlock code={LIST_SHAPE} caption={t("listShape")} />
              </div>
            </div>
          </Section>

          <Section id="errors" title={t("errors")} about={t("errorsAbout")}>
            <div role="table" aria-label={t("errors")}>
              {ERRORS.map((row) => (
                <div key={row.code} role="row" className="grid grid-cols-[44px_170px_1fr] items-baseline gap-3 border-t border-line px-3.5 py-2.5">
                  <span role="cell" className="font-mono text-12 font-semibold text-ink">{row.status}</span>
                  <span role="cell" className="truncate font-mono text-11 text-ink-2">{row.code}</span>
                  <span role="cell" className="text-115 leading-[17px] text-ink-2">{t(row.status === 400 ? "error400" : row.status === 401 ? "error401" : row.status === 403 ? "error403" : row.status === 404 ? "error404" : row.status === 409 ? "error409" : "error429")}</span>
                </div>
              ))}
            </div>
            <p className="border-t border-line px-3.5 py-2.5 text-115 leading-[17px] text-ink-2">
              <span className="font-semibold text-ink">{t("rateLimits")}</span> {t("rateHint")} <Code>X-RateLimit-Limit</Code> {t("listMiddle")} <Code>X-RateLimit-Remaining</Code> {t("rateEnd")}
            </p>
          </Section>

          {ENDPOINT_GROUPS.map((group) => (
            <Section key={group.id} id={group.id} title={titleFor(group.id, group.title)} about={aboutFor(group.id, group.about)}>
              <ul className="flex flex-col">{group.endpoints.map((endpoint) => <EndpointRow key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} />)}</ul>
            </Section>
          ))}

          <Section id="webhooks" title={t("webhooks")} about={t("webhooksAbout")}>
            <div className="flex flex-col gap-3 border-t border-line p-3.5">
              <ul className="flex flex-col gap-2 text-115 leading-[17px] text-ink-2">
                <li><span className="font-semibold text-ink">{t("delivery")}</span> {t("deliveryHint")}</li>
                <li><span className="font-semibold text-ink">{t("retries")}</span> {t("retriesHint")}</li>
                <li><span className="font-semibold text-ink">{t("signature")}</span> {t("signatureHint")}</li>
                <li><span className="font-semibold text-ink">{t("order")}</span> {t("orderHint")} <Code>id</Code> {t("orderEnd")}</li>
              </ul>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <CodeBlock code={WEBHOOK_BODY} caption={t("bodyExample")} />
                <CodeBlock code={SIGNATURE} caption={t("signatureExample")} />
              </div>
              <div className="flex flex-col gap-[7px]">
                <Eyebrow>{t("eventsTitle")}</Eyebrow>
                <div className="flex flex-wrap gap-[5px]">{WEBHOOK_EVENTS.map((type) => <Chip key={type} mono>{type}</Chip>)}</div>
              </div>
            </div>
          </Section>

          <Section id="mcp" title={t("mcp")} about={t("mcpAbout")}>
            <p className="border-t border-line px-3.5 py-3 text-115 leading-[17px] text-ink-2">
              {t("mcpBefore")} <Code>{origin}/api/mcp</Code> {t("mcpMiddle")} <Link href="/developers" className="font-semibold text-brand-strong hover:underline">{t("developer")}</Link>.
            </p>
          </Section>
        </div>

        <nav aria-label={t("onPage")} className="hidden w-[200px] shrink-0 xl:sticky xl:top-0 xl:block">
          <Card className="flex flex-col gap-1 p-3.5">
            <Eyebrow className="pb-1">{t("onPage")}</Eyebrow>
            {SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="rounded-md px-1.5 py-1 text-115 font-medium text-ink-2 hover:bg-subtle hover:text-ink">{titleFor(section.id, section.label)}</a>
            ))}
          </Card>
        </nav>
      </div>
    </Page>
  );
}
