import Link from "next/link";
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
  return (
    <li className="flex flex-col gap-1.5 border-t border-line px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Pill tone={METHOD_TONE[endpoint.method]} size="sm" className="w-[46px] justify-center font-mono">{endpoint.method}</Pill>
        <span className="font-mono text-12 font-medium text-ink">/api/v1{endpoint.path}</span>
        <Chip mono className="ml-auto">{endpoint.scope}</Chip>
      </div>
      <p className="text-115 leading-[17px] text-ink-2">{endpoint.does}</p>
      {endpoint.fields ? (
        <p className="text-105 leading-[16px] text-ink-3">
          {endpoint.method === "GET" ? "Query: " : "Body: "}
          {endpoint.fields.map((field, index) => {
            const required = /\*/.test(field);
            return (
              <span key={field}>
                {index > 0 ? ", " : ""}
                <span className={cn("font-mono", required ? "font-semibold text-ink-2" : undefined)}>{field.replace("*", "")}</span>
                {required ? <span className="text-ink-2"> (required)</span> : null}
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
  // Rendered after the app has loaded, so the address is this instance's own.
  const origin = typeof window === "undefined" ? "https://your-linki-address" : window.location.origin;

  return (
    <Page title="API reference" crumbs={[{ label: "Developer API", href: "/developers" }]} meta={<span className="text-11 text-ink-3">{endpointCount()} endpoints · version {API_VERSION}</span>}>
      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <Section id="basics" title="Basics" about="A JSON API over HTTPS, for your own code. Every request acts on the workspace its key belongs to.">
            <div className="flex flex-col gap-3 border-t border-line p-3.5">
              <ul className="flex flex-col gap-2 text-115 leading-[17px] text-ink-2">
                <li><span className="font-semibold text-ink">Address.</span> Every path below is under <Code>{origin}/api/v1</Code>.</li>
                <li><span className="font-semibold text-ink">Key.</span> Send <Code>Authorization: Bearer lnk_…</Code> on every request. Keys are made on the <Link href="/developers" className="font-semibold text-brand-strong hover:underline">Developer API</Link> page, each with the scopes it needs; a key is shown once.</li>
                <li><span className="font-semibold text-ink">Lists.</span> A list answers with <Code>data</Code> and <Code>pagination</Code>. <Code>limit</Code> is 1 to 500 (100 if left out); <Code>offset</Code> skips that many.</li>
                <li><span className="font-semibold text-ink">Version.</span> Every answer carries <Code>X-API-Version: {API_VERSION}</Code>.</li>
                <li><span className="font-semibold text-ink">Audit.</span> {"Every change made with a key is written to the workspace's audit log, with the key's name and the caller's address."}</li>
              </ul>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <CodeBlock code={curlExample(origin)} caption="A first request" />
                <CodeBlock code={LIST_SHAPE} caption="What a list looks like" />
              </div>
            </div>
          </Section>

          <Section id="errors" title="Errors and limits" about="An error is a status and a JSON body with a code in `error`.">
            <div role="table" aria-label="Errors">
              {ERRORS.map((row) => (
                <div key={row.code} role="row" className="grid grid-cols-[44px_170px_1fr] items-baseline gap-3 border-t border-line px-3.5 py-2.5">
                  <span role="cell" className="font-mono text-12 font-semibold text-ink">{row.status}</span>
                  <span role="cell" className="truncate font-mono text-11 text-ink-2">{row.code}</span>
                  <span role="cell" className="text-115 leading-[17px] text-ink-2">{row.means}</span>
                </div>
              ))}
            </div>
            <p className="border-t border-line px-3.5 py-2.5 text-115 leading-[17px] text-ink-2">
              <span className="font-semibold text-ink">Rate limits.</span> A key has no limit unless one is set on it. A key with a limit gets <Code>X-RateLimit-Limit</Code> and <Code>X-RateLimit-Remaining</Code> on every answer; the limit is counted over the last 60 seconds, for that key alone.
            </p>
          </Section>

          {ENDPOINT_GROUPS.map((group) => (
            <Section key={group.id} id={group.id} title={group.title} about={group.about}>
              <ul className="flex flex-col">{group.endpoints.map((endpoint) => <EndpointRow key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} />)}</ul>
            </Section>
          ))}

          <Section id="webhooks" title="Webhooks" about="Linki calls your address when something happens, so you do not have to ask.">
            <div className="flex flex-col gap-3 border-t border-line p-3.5">
              <ul className="flex flex-col gap-2 text-115 leading-[17px] text-ink-2">
                <li><span className="font-semibold text-ink">Delivery.</span> A POST with a JSON body to a public https address. Answer with any 2xx within 10 seconds. Redirects are not followed.</li>
                <li><span className="font-semibold text-ink">Retries.</span> Anything else is tried again: 8 attempts in all over about four hours, waiting 2 minutes, then 4, then 8 and so on. After the last, the delivery goes to the dead-letter queue, where it can be sent again by hand.</li>
                <li><span className="font-semibold text-ink">Signature.</span> Each endpoint has its own signing secret, shown once when it is added. Check the signature before trusting a request, and refuse one whose timestamp is more than a few minutes old.</li>
                <li><span className="font-semibold text-ink">Order.</span> Events can arrive out of order or more than once. Use the <Code>id</Code> of the event to ignore one you have seen.</li>
              </ul>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <CodeBlock code={WEBHOOK_BODY} caption="The body of a delivery" />
                <CodeBlock code={SIGNATURE} caption="Headers, and how the signature is made" />
              </div>
              <div className="flex flex-col gap-[7px]">
                <Eyebrow>Events</Eyebrow>
                <div className="flex flex-wrap gap-[5px]">{WEBHOOK_EVENTS.map((type) => <Chip key={type} mono>{type}</Chip>)}</div>
              </div>
            </div>
          </Section>

          <Section id="mcp" title="MCP server" about="For an AI client rather than your own code.">
            <p className="border-t border-line px-3.5 py-3 text-115 leading-[17px] text-ink-2">
              The MCP server at <Code>{origin}/api/mcp</Code> offers the whole app as tools, not only what this API covers. A client signs in through the browser as a member and acts with the role that member has, so it needs no API key. The command to add it is on the <Link href="/developers" className="font-semibold text-brand-strong hover:underline">Developer API</Link> page.
            </p>
          </Section>
        </div>

        <nav aria-label="On this page" className="hidden w-[200px] shrink-0 xl:sticky xl:top-0 xl:block">
          <Card className="flex flex-col gap-1 p-3.5">
            <Eyebrow className="pb-1">On this page</Eyebrow>
            {SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="rounded-md px-1.5 py-1 text-115 font-medium text-ink-2 hover:bg-subtle hover:text-ink">{section.label}</a>
            ))}
          </Card>
        </nav>
      </div>
    </Page>
  );
}
