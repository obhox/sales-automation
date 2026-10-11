import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Page } from "@/components/shell";
import { Alert, Button, Card, ErrorState, Eyebrow, Pill, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount, formatDateTime, formatRelative } from "@/lib/client/format";
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
function Counts({ items, labelKey, empty = "Nothing recorded" }: { items: Row[]; labelKey: string | string[]; empty?: string }) {
  const keys = Array.isArray(labelKey) ? labelKey : [labelKey];
  if (items.length === 0) return <Card className="px-3.5 py-3 text-115 text-ink-3">{empty}</Card>;
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
  if (isEmpty) return <Card className="px-3.5 py-3 text-115 text-ink-3">{empty}</Card>;
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
      title="Instance admin"
      meta={<span className="text-11 text-ink-3">{data ? `Every workspace on this instance · updated ${formatRelative(data.generated_at)}` : "Every workspace on this instance"}</span>}
      actions={
        <>
          <Button icon={RefreshCw} loading={loading && Boolean(data)} onClick={refresh}>Refresh</Button>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {error && !data ? (
        <Card><ErrorState message={errorMessage(error)} onRetry={refresh} /></Card>
      ) : !data ? (
        <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading the instance">
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[78px] rounded-lg" />)}</div>
          <Skeleton className="h-[180px] rounded-lg" />
          <Skeleton className="h-[260px] rounded-lg" />
        </div>
      ) : (
        <>
          <Alert tone="neutral">Counts and names of things only. No message text, contact details, prompts or credentials are read on this page.</Alert>

          <Section title="Needs attention" hint="Anything above zero here usually wants a person to look.">
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
              <Stat label="Uncertain email jobs" value={count(queue.uncertain)} alert={num(queue.uncertain) > 0} />
              <Stat label="Stale leases" value={count(queue.stale_leases)} alert={num(queue.stale_leases) > 0} />
              <Stat label="Stuck tracks" value={count(campaigns.stuck_tracks)} alert={num(campaigns.stuck_tracks) > 0} />
              <Stat label="Loops not running" value={count(notRunning)} alert={notRunning > 0} />
              <Stat label="Unprocessed events" value={count(events.unprocessed)} alert={num(events.unprocessed) > 0} />
            </div>
          </Section>

          <Section title="Instance">
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
              <Stat label="Version" value={text(instance.version)} />
              <Stat label="Environment" value={text(instance.node_env)} />
              <Stat label="Process" value={uptimeLabel(num(instance.process_uptime_seconds))} />
              <Stat label="Database size" value={formatBytes(num(instance.database_bytes))} />
            </div>
          </Section>

          <Section title="Across all workspaces">
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
              <Stat label="Workspaces" value={count(tenancy.workspaces)} />
              <Stat label="Users" value={count(tenancy.users)} />
              <Stat label="Contacts" value={count(volume.contacts)} />
              <Stat label="Companies" value={count(volume.companies)} />
              <Stat label="Lists" value={count(volume.lists)} />
              <Stat label="Campaigns" value={count(volume.workflows)} />
              <Stat label="LinkedIn accounts" value={count(volume.linkedin_accounts)} />
              <Stat label="Mailboxes" value={count(volume.email_accounts)} />
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-x-3.5 gap-y-5 lg:grid-cols-2">
            <Section title="Email queue" hint="Jobs by status.">
              <Counts items={rows(queue.by_status)} labelKey="status" />
            </Section>
            <Section title="Campaign runs">
              <Counts items={rows(campaigns.runs_by_status)} labelKey="status" />
            </Section>
            <Section title="Delivery">
              <div className="grid grid-cols-2 gap-3.5">
                <Stat label="Sent" value={count(sent.total)} />
                <Stat label="Delivered" value={count(sent.delivered)} />
                <Stat label="Bounced" value={count(sent.bounced)} alert={num(sent.bounced) > 0} />
                <Stat label="Complaints" value={count(sent.complained)} alert={num(sent.complained) > 0} />
                <Stat label="Mailboxes verified" value={`${count(senders.verified)} / ${count(senders.total)}`} />
                <Stat label="Mailboxes paused" value={count(senders.paused)} alert={num(senders.paused) > 0} />
              </div>
            </Section>
            <div className="flex flex-col gap-5">
              <Section title="LinkedIn accounts" hint="Session cookies are never read here.">
                <div className="grid grid-cols-3 gap-3.5">
                  <Stat label="Total" value={count(linkedin.total)} />
                  <Stat label="Signed in" value={count(linkedin.authenticated)} />
                  <Stat label="Need sign-in" value={count(linkedin.needs_reauth)} alert={num(linkedin.needs_reauth) > 0} />
                </div>
              </Section>
              <Section title="Suppressions">
                <Counts items={rows(delivery.suppressions_by_kind)} labelKey="kind" />
              </Section>
            </div>
            <Section title="Track state" hint="Where enrolled contacts stand, by channel.">
              <Counts items={rows(campaigns.tracks_by_state)} labelKey={["track", "state"]} />
            </Section>
            <Section title="AI spend" hint="Tokens and cost only.">
              <div className="grid grid-cols-2 gap-3.5">
                <Stat label="Requests" value={count(ai.generations)} />
                <Stat label="Cost" value={`$${num(ai.cost_usd).toFixed(2)}`} />
                <Stat label="Tokens read" value={count(ai.input_tokens)} />
                <Stat label="Tokens written" value={count(ai.output_tokens)} />
              </div>
            </Section>
          </div>

          <Section title="Background loops" hint="Each holds a lease and renews it on every pass. One that has stopped renewing is not running.">
            <Table label="Background loops" isEmpty={leases.length === 0} empty="No loop has started yet. They start with the first request that needs them." columns={[{ name: "Loop" }, { name: "Held by" }, { name: "State" }, { name: "Last pass" }, { name: "Lease ends" }]}>
              {leases.map((lease, index) => (
                <tr key={index}>
                  <td className={cn(TD, "font-medium text-ink")}>{text(lease.name)}</td>
                  <td className={cn(TD, "font-mono text-105")}>{text(lease.owner_id)}</td>
                  <td className={TD}>
                    {num(lease.alive) === 0 ? <Pill tone="bad" dot>Expired</Pill> : num(lease.stalled) === 1 ? <Pill tone="warn" dot>Stalled</Pill> : <Pill tone="good" dot>Running</Pill>}
                  </td>
                  <td className={TD}>{formatRelative(String(lease.heartbeat_at ?? ""))}</td>
                  <td className={TD}>{formatDateTime(String(lease.expires_at ?? ""))}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="Workspaces" hint="One line for each.">
            <Table
              label="Workspaces" isEmpty={(tenants.data?.workspaces ?? []).length === 0} empty={tenants.error ? errorMessage(tenants.error) : "No workspaces."}
              columns={[{ name: "Workspace" }, { name: "Members", right: true }, { name: "Contacts", right: true }, { name: "Runs", right: true }, { name: "Running", right: true }, { name: "LinkedIn", right: true }, { name: "Mailboxes", right: true }, { name: "Failed", right: true }, { name: "Uncertain", right: true }, { name: "AI cost", right: true }, { name: "Last event" }]}
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
                  <td className={cn(TD, "whitespace-nowrap")}>{workspace.last_event_at ? formatRelative(String(workspace.last_event_at)) : "—"}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <div className="grid grid-cols-1 gap-x-3.5 gap-y-5 lg:grid-cols-2">
            <Section title="MCP tools" hint="Calls, how many succeeded, and how long they took.">
              <Table label="MCP tools" isEmpty={rows(governance.mcp_tools).length === 0} empty="No MCP tool has been called." columns={[{ name: "Tool" }, { name: "Calls", right: true }, { name: "Succeeded", right: true }, { name: "Average", right: true }]}>
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
            <Section title="Audit activity" hint="The twenty most frequent actions. Names only.">
              <Counts items={rows(governance.audit_actions)} labelKey="action" />
            </Section>
          </div>

          <Section title="Recent events" hint="The latest fifty: what kind and when. What they carried is not read.">
            <Table label="Recent events" isEmpty={data.recent_events.length === 0} empty="No events yet." columns={[{ name: "Event" }, { name: "About" }, { name: "Workspace" }, { name: "When" }]}>
              {data.recent_events.map((event, index) => (
                <tr key={index}>
                  <td className={cn(TD, "font-mono text-11 text-ink")}>{text(event.type)}</td>
                  <td className={TD}>{text(event.entity_type)}</td>
                  <td className={cn(TD, "font-mono text-105")}>{text(event.workspace_id)}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>{formatDateTime(String(event.occurred_at ?? ""))}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <p className="pb-2 text-105 text-ink-3">Signed in as {viewer}, an instance administrator. This page is listed for nobody else and answers them as if it were not there.</p>
        </>
      )}
    </Page>
  );
}
