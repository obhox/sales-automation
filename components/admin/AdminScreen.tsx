import type { ReactNode } from "react";
import {useTranslations, useLocale} from "next-intl";
import {formatRelativeByLocale, formatDateTimeByLocale} from "@/lib/client/localize-relative";
import { RefreshCw } from "lucide-react";
import { Page } from "@/components/shell";
import { Alert, Button, Card, ErrorState, Eyebrow, Pill, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { useApi } from "@/lib/client/data";
import { formatBytes, uptimeLabel } from "@/components/developers/model";

// The instance operator's view of every workspace at once. What it shows is decided by
// the two routes behind it (pages/api/admin/*): counts and metadata only, never message
// text, contact details or credentials. This file only lays that out.

type Row = Record<string, unknown>;

interface Overview {
  generated_at: string;
  instance: Row;
  tenancy: Row;
  volume: Row;
  email_queue: Row;
  deliverability: Row;
  campaigns: Row;
  linkedin: Row;
  workers: Row;
  eventing: Row;
  governance: Row;
  ai_spend: Row;
  recent_events: Row[];
}

interface Tenants {
  workspaces: Row[];
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
const text = (value: unknown): string => (value === null || value === undefined || value === "" ? "—" : String(value));
/** A count; the routes send -1 for one they could not make. */
const count = (value: unknown): string => (num(value) < 0 ? "—" : formatCount(num(value)));
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const part = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-10 font-semibold uppercase tracking-label text-ink-3">{title}</h2>
        {hint ? <p className="text-105 text-ink-3">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** One figure. `alert` marks a count that should be zero and is not. */
function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <Card className={cn("flex min-w-0 flex-col gap-2 p-3.5", alert && "border-bad/30 bg-bad-tint")}>
      <Eyebrow className={cn("truncate", alert && "text-bad")}>{label}</Eyebrow>
      <span className={cn("truncate text-22 font-semibold tracking-figure", alert ? "text-bad" : "text-ink")}>{value}</span>
    </Card>
  );
}

/** A name and a count on each line. */
function Counts({ items, labelKey, empty = "" }: { items: Row[]; labelKey: string | string[]; empty?: string }) {
  const t = useTranslations("InstanceAdmin");
  const keys = Array.isArray(labelKey) ? labelKey : [labelKey];
  if (items.length === 0) return <Card className="px-3.5 py-3 text-115 text-ink-3">{empty || t("s9015edbf7")}</Card>;
  return (
    <Card className="flex flex-col overflow-hidden">
      {items.map((item, index) => (
        <div key={index} className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2 first:border-t-0">
          <span className="truncate text-115 text-ink-2">{keys.map((key) => text(item[key])).join(" · ")}</span>
          <span className="shrink-0 text-115 font-semibold tabular-nums text-ink">{count(item.count)}</span>
        </div>
      ))}
    </Card>
  );
}

function Table({ label, columns, children, empty, isEmpty }: { label: string; columns: Array<{ name: string; right?: boolean }>; children: ReactNode; empty: string; isEmpty: boolean }) {
  const t = useTranslations("InstanceAdmin");
  if (isEmpty) return <Card className="px-3.5 py-3 text-115 text-ink-3">{empty || t("s9015edbf7")}</Card>;
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="h-[31px] bg-subtle">
              {columns.map((column) => (
                <th key={column.name} scope="col" className={cn("whitespace-nowrap px-3.5 text-10 font-semibold uppercase tracking-label text-ink-3", column.right && "text-right")}>{column.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

const TD = "border-t border-line px-3.5 py-2 text-115 text-ink-2";
const TD_NUM = cn(TD, "text-right tabular-nums text-ink");

/** The instance operator's dashboard. Reached only by an address on the instance's own allowlist. */
export function AdminScreen({ viewer }: { viewer: string }) {
  const t = useTranslations("InstanceAdmin");
  const locale = useLocale();
  const overview = useApi<Overview>("/api/admin/overview");
  const tenants = useApi<Tenants>("/api/admin/workspaces");
  const data = overview.data;
  const loading = overview.isValidating || tenants.isValidating;
  const refresh = () => {
    void overview.mutate();
    void tenants.mutate();
  };

  const queue = part(data?.email_queue);
  const campaigns = part(data?.campaigns);
  const events = part(part(data?.eventing).domain_events);
  const leases = rows(part(data?.workers).leases);
  const notRunning = leases.filter((lease) => num(lease.alive) === 0 || num(lease.stalled) === 1).length;
  const volume = part(data?.volume);
  const tenancy = part(data?.tenancy);
  const instance = part(data?.instance);
  const delivery = part(data?.deliverability);
  const sent = part(delivery.sent_totals);
  const senders = part(delivery.senders);
  const linkedin = part(part(data?.linkedin).accounts);
  const governance = part(data?.governance);
  const ai = part(part(data?.ai_spend).totals);
  const error = overview.error ?? tenants.error;

  return (
    <Page
      title={t("s3ed6388a9")}
      meta={<span className="text-11 text-ink-3">{data ? t("sdd64b5775") + " · " + t("sea7ed9a12", {relative: formatRelativeByLocale(data.generated_at,locale)}) : t("sdd64b5775")}</span>}
      actions={
        <>
          <Button icon={RefreshCw} loading={loading && Boolean(data)} onClick={refresh}>{t("s56e3badc4")}</Button>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {error && !data ? (
        <Card><ErrorState message={errorMessage(error)} onRetry={refresh} /></Card>
      ) : !data ? (
        <div className="flex flex-col gap-3.5" aria-busy="true" aria-label={t("s3fce72df9")}>
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[78px] rounded-lg" />)}</div>
          <Skeleton className="h-[180px] rounded-lg" />
          <Skeleton className="h-[260px] rounded-lg" />
        </div>
      ) : (
        <>
          <Alert tone="neutral">{t("s47239e1a6")}</Alert>

          <Section title={t("sa126722ec")} hint={t("s94d1b6d66")}>
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
              <Stat label={t("s2b47a8a6b")} value={count(queue.uncertain)} alert={num(queue.uncertain) > 0} />
              <Stat label={t("s34d67076a")} value={count(queue.stale_leases)} alert={num(queue.stale_leases) > 0} />
              <Stat label={t("s751e35214")} value={count(campaigns.stuck_tracks)} alert={num(campaigns.stuck_tracks) > 0} />
              <Stat label={t("s6830a66ef")} value={count(notRunning)} alert={notRunning > 0} />
              <Stat label={t("s751109e76")} value={count(events.unprocessed)} alert={num(events.unprocessed) > 0} />
            </div>
          </Section>

          <Section title={t("s5f97f8775")}>
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
              <Stat label={t("s2da600bf9")} value={text(instance.version)} />
              <Stat label={t("sd443a1185")} value={text(instance.node_env)} />
              <Stat label={t("s12f4c13a6")} value={uptimeLabel(num(instance.process_uptime_seconds))} />
              <Stat label={t("s02b3304d7")} value={formatBytes(num(instance.database_bytes))} />
            </div>
          </Section>

          <Section title={t("s86254ee18")}>
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
              <Stat label={t("s205b4561e")} value={count(tenancy.workspaces)} />
              <Stat label={t("s57f2b181d")} value={count(tenancy.users)} />
              <Stat label={t("sb0dd615cb")} value={count(volume.contacts)} />
              <Stat label={t("s9dba7ad7c")} value={count(volume.companies)} />
              <Stat label={t("s57c9502a7")} value={count(volume.lists)} />
              <Stat label={t("s01a23a288")} value={count(volume.workflows)} />
              <Stat label={t("s555c048b2")} value={count(volume.linkedin_accounts)} />
              <Stat label={t("sf4de32abf")} value={count(volume.email_accounts)} />
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-x-3.5 gap-y-5 lg:grid-cols-2">
            <Section title={t("s3e256b068")} hint={t("sd21b3d40e")}>
              <Counts items={rows(queue.by_status)} labelKey="status" />
            </Section>
            <Section title={t("s1bb60b444")}>
              <Counts items={rows(campaigns.runs_by_status)} labelKey="status" />
            </Section>
            <Section title={t("s9631af52c")}>
              <div className="grid grid-cols-2 gap-3.5">
                <Stat label={t("s35f49dcfb")} value={count(sent.total)} />
                <Stat label={t("seea956cde")} value={count(sent.delivered)} />
                <Stat label={t("sdfe939fe6")} value={count(sent.bounced)} alert={num(sent.bounced) > 0} />
                <Stat label={t("s527dcedaf")} value={count(sent.complained)} alert={num(sent.complained) > 0} />
                <Stat label={t("s1410fe400")} value={`${count(senders.verified)} / ${count(senders.total)}`} />
                <Stat label={t("se77fb33ae")} value={count(senders.paused)} alert={num(senders.paused) > 0} />
              </div>
            </Section>
            <div className="flex flex-col gap-5">
              <Section title={t("s555c048b2")} hint={t("sa92ed7c18")}>
                <div className="grid grid-cols-3 gap-3.5">
                  <Stat label={t("sb25928c69")} value={count(linkedin.total)} />
                  <Stat label={t("s1b6c524ff")} value={count(linkedin.authenticated)} />
                  <Stat label={t("s66b32475d")} value={count(linkedin.needs_reauth)} alert={num(linkedin.needs_reauth) > 0} />
                </div>
              </Section>
              <Section title={t("s3c5128961")}>
                <Counts items={rows(delivery.suppressions_by_kind)} labelKey="kind" />
              </Section>
            </div>
            <Section title={t("sffb68eab8")} hint={t("s34bc18043")}>
              <Counts items={rows(campaigns.tracks_by_state)} labelKey={["track", "state"]} />
            </Section>
            <Section title={t("sac444a934")} hint={t("s3e820672f")}>
              <div className="grid grid-cols-2 gap-3.5">
                <Stat label={t("sf7194e6a0")} value={count(ai.generations)} />
                <Stat label={t("s64ae43e8f")} value={`$${num(ai.cost_usd).toFixed(2)}`} />
                <Stat label={t("sdfde30330")} value={count(ai.input_tokens)} />
                <Stat label={t("s10ad09806")} value={count(ai.output_tokens)} />
              </div>
            </Section>
          </div>

          <Section title={t("sf0d5db8f2")} hint={t("s923024821")}>
            <Table label={t("sf0d5db8f2")} isEmpty={leases.length === 0} empty={t("sfe485af3c")} columns={[{ name: t("sdc7f77b4c") }, { name: t("s0d4a73882") }, { name: t("sa72502067") }, { name: t("sa8318b711") }, { name: t("s457148374") }]}>
              {leases.map((lease, index) => (
                <tr key={index}>
                  <td className={cn(TD, "font-medium text-ink")}>{text(lease.name)}</td>
                  <td className={cn(TD, "font-mono text-105")}>{text(lease.owner_id)}</td>
                  <td className={TD}>
                    {num(lease.alive) === 0 ? <Pill tone="bad" dot>{t("sa689a999a")}</Pill> : num(lease.stalled) === 1 ? <Pill tone="warn" dot>{t("s801bdc3fd")}</Pill> : <Pill tone="good" dot>{t("s73989d9c5")}</Pill>}
                  </td>
                  <td className={TD}>{formatRelativeByLocale(String(lease.heartbeat_at ?? ""), locale)}</td>
                  <td className={TD}>{formatDateTimeByLocale(String(lease.expires_at ?? ""), locale)}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title={t("s205b4561e")} hint={t("s8d73a0c8b")}>
            <Table
              label={t("s205b4561e")} isEmpty={(tenants.data?.workspaces ?? []).length === 0} empty={tenants.error ? errorMessage(tenants.error) : "No workspaces."}
              columns={[{ name: t("s4ca0a75c2") }, { name: t("s1cb449c11"), right: true }, { name: t("sb0dd615cb"), right: true }, { name: t("sfcde5c325"), right: true }, { name: t("s73989d9c5"), right: true }, { name: t("s6b6390a44"), right: true }, { name: t("sf4de32abf"), right: true }, { name: t("s09fef5d8d"), right: true }, { name: t("sc6a143441"), right: true }, { name: t("s3c3d55a71"), right: true }, { name: t("sc26a0a477") }]}
            >
              {(tenants.data?.workspaces ?? []).map((workspace, index) => (
                <tr key={index}>
                  <td className={TD}>
                    <span className="block truncate font-medium text-ink">{text(workspace.name)}</span>
                    <span className="block truncate text-105 text-ink-3">{text(workspace.slug)}</span>
                  </td>
                  <td className={TD_NUM}>{count(workspace.members)}</td>
                  <td className={TD_NUM}>{count(workspace.contacts)}</td>
                  <td className={TD_NUM}>{count(workspace.runs)}</td>
                  <td className={TD_NUM}>{count(workspace.active_runs)}</td>
                  <td className={TD_NUM}>{count(workspace.linkedin_authenticated)} / {count(workspace.linkedin_accounts)}</td>
                  <td className={TD_NUM}>{count(workspace.email_accounts)}</td>
                  <td className={cn(TD_NUM, num(workspace.failed_jobs) > 0 && "text-bad")}>{count(workspace.failed_jobs)}</td>
                  <td className={cn(TD_NUM, num(workspace.uncertain_jobs) > 0 && "text-bad")}>{count(workspace.uncertain_jobs)}</td>
                  <td className={TD_NUM}>${num(workspace.ai_cost_usd).toFixed(2)}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>{workspace.last_event_at ? formatRelativeByLocale(String(workspace.last_event_at),locale) : "—"}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <div className="grid grid-cols-1 gap-x-3.5 gap-y-5 lg:grid-cols-2">
            <Section title={t("s89c758912")} hint={t("sb493c7010")}>
              <Table label={t("s89c758912")} isEmpty={rows(governance.mcp_tools).length === 0} empty={t("s60b82f67b")} columns={[{ name: t("s9a830c714") }, { name: t("s0a19b7e26"), right: true }, { name: t("sc8fbda909"), right: true }, { name: t("s15f86c051"), right: true }]}>
                {rows(governance.mcp_tools).map((tool, index) => (
                  <tr key={index}>
                    <td className={cn(TD, "font-mono text-11 text-ink")}>{text(tool.tool_name)}</td>
                    <td className={TD_NUM}>{count(tool.calls)}</td>
                    <td className={TD_NUM}>{count(tool.succeeded)}</td>
                    <td className={TD_NUM}>{count(tool.avg_ms)} ms</td>
                  </tr>
                ))}
              </Table>
            </Section>
            <Section title={t("s72cba9eb1")} hint={t("s13187c7b7")}>
              <Counts items={rows(governance.audit_actions)} labelKey="action" />
            </Section>
          </div>

          <Section title={t("s8b65e36bc")} hint={t("s82a59a64e")}>
            <Table label={t("s8b65e36bc")} isEmpty={data.recent_events.length === 0} empty={t("s32b6ad191")} columns={[{ name: t("sad8919ace") }, { name: t("s6b21fb791") }, { name: t("s4ca0a75c2") }, { name: t("s769bb19e6") }]}>
              {data.recent_events.map((event, index) => (
                <tr key={index}>
                  <td className={cn(TD, "font-mono text-11 text-ink")}>{text(event.type)}</td>
                  <td className={TD}>{text(event.entity_type)}</td>
                  <td className={cn(TD, "font-mono text-105")}>{text(event.workspace_id)}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>{formatDateTimeByLocale(String(event.occurred_at ?? ""),locale)}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <p className="pb-2 text-105 text-ink-3">{t("s265b88f06", {viewer})}</p>
        </>
      )}
    </Page>
  );
}
