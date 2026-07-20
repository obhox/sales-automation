import Head from "next/head";
import { useCallback, useEffect, useState } from "react";
import type { GetServerSidePropsContext } from "next";
import { RiRefreshLine, RiAlertLine } from "react-icons/ri";
import { getSuperadmin } from "@/lib/superadmin";

// Instance-wide admin dashboard. Server-side gated: a non-admin gets a 404, so the
// surface is not discoverable. Everything rendered here is an aggregate or metadata -
// no credentials, no message content, no lead PII (see pages/api/admin/*).

type Row = Record<string, unknown>;

interface Overview {
  generated_at: string;
  viewer: string;
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

interface WorkspacesPayload {
  workspaces: Row[];
  users: Row[];
  unattributed: Row;
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
const text = (value: unknown): string => (value === null || value === undefined || value === "" ? "—" : String(value));
const fmt = (value: unknown): string => {
  const n = num(value);
  return n < 0 ? "—" : n.toLocaleString();
};
const when = (value: unknown): string => {
  if (!value) return "—";
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toLocaleString();
};
const bytes = (value: unknown): string => {
  const n = num(value);
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-base-content">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-base-content/45">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]">
      <div className="mb-1 flex items-center gap-1.5 text-[13px] text-base-content/45">
        {alert && <RiAlertLine size={13} className="text-base-content/70" />}
        {label}
      </div>
      <div className={`text-[24px] font-semibold tracking-[-0.02em] ${alert ? "text-base-content" : "text-base-content"}`}>
        {value}
      </div>
    </div>
  );
}

/** Rows of {label, count} rendered as a compact table. */
function CountTable({ rows, labelKey, countKey, empty = "Nothing recorded" }: {
  rows: Row[]; labelKey: string; countKey: string; empty?: string;
}) {
  if (!rows?.length) return <p className="text-[13px] text-base-content/40">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
      <table className="w-full text-[14px]">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
              <td className="px-5 py-2.5 text-base-content/70">{text(row[labelKey])}</td>
              <td className="px-5 py-2.5 text-right font-medium tabular-nums text-base-content">{fmt(row[countKey])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScrollTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
      <table className="w-full min-w-[720px] text-[13.5px]">
        <thead>
          <tr className="border-b border-[var(--border-subtle)]">
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-2.5 text-left font-medium text-base-content/45">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default function AdminPage({ viewer }: { viewer: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<WorkspacesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([fetch("/api/admin/overview"), fetch("/api/admin/workspaces")]);
      if (!a.ok || !b.ok) throw new Error(`Failed to load admin data (${a.status}/${b.status})`);
      setOverview(await a.json());
      setTenants(await b.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const q = (overview?.email_queue ?? {}) as Row;
  const camp = (overview?.campaigns ?? {}) as Row;
  const ev = ((overview?.eventing ?? {}) as Row).domain_events as Row | undefined;
  const leases = (((overview?.workers ?? {}) as Row).leases ?? []) as Row[];
  const deadLeases = leases.filter((l) => num(l.alive) === 0).length;
  const vol = (overview?.volume ?? {}) as Row;
  const ten = (overview?.tenancy ?? {}) as Row;
  const inst = (overview?.instance ?? {}) as Row;
  const del = (overview?.deliverability ?? {}) as Row;
  const sent = (del.sent_totals ?? {}) as Row;
  const senders = (del.senders ?? {}) as Row;
  const li = ((overview?.linkedin ?? {}) as Row).accounts as Row | undefined;
  const gov = (overview?.governance ?? {}) as Row;
  const ai = (overview?.ai_spend ?? {}) as Row;
  const aiTotals = (ai.totals ?? {}) as Row;

  return (
    <>
      <Head><title>Platform admin · Linki</title></Head>
      <div className="space-y-10">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Instance</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Platform admin</h1>
            <p className="mt-2 text-[15px] text-base-content/50">
              Everything happening across every workspace on this instance. Read-only, aggregates and metadata only.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-base-content/40">
              {overview ? `Updated ${when(overview.generated_at)}` : "Loading…"}
            </span>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-base-100 px-3 py-1.5 text-sm font-medium text-base-content/70 transition-colors hover:bg-base-200 disabled:opacity-50"
            >
              <RiRefreshLine size={13} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-[var(--border)] bg-base-100 p-5 text-[14px] text-base-content/70">{error}</div>
        )}

        <Section title="Needs attention" hint="Non-zero values here usually mean a human should look.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Uncertain email jobs" value={fmt(q.uncertain)} alert={num(q.uncertain) > 0} />
            <Stat label="Stale leases" value={fmt(q.stale_leases)} alert={num(q.stale_leases) > 0} />
            <Stat label="Stuck tracks" value={fmt(camp.stuck_tracks)} alert={num(camp.stuck_tracks) > 0} />
            <Stat label="Dead workers" value={fmt(deadLeases)} alert={deadLeases > 0} />
            <Stat label="Unprocessed events" value={fmt(ev?.unprocessed)} alert={num(ev?.unprocessed) > 0} />
          </div>
        </Section>

        <Section title="Instance">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Version" value={text(inst.version)} />
            <Stat label="Environment" value={text(inst.node_env)} />
            <Stat label="Process uptime" value={`${Math.round(num(inst.process_uptime_seconds) / 60)} min`} />
            <Stat label="Database size" value={bytes(inst.database_bytes)} />
          </div>
        </Section>

        <Section title="Tenancy">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Workspaces" value={fmt(ten.workspaces)} />
            <Stat label="Users" value={fmt(ten.users)} />
            <Stat label="Contacts" value={fmt(vol.contacts)} />
            <Stat label="Companies" value={fmt(vol.companies)} />
            <Stat label="Lists" value={fmt(vol.lists)} />
            <Stat label="Workflows" value={fmt(vol.workflows)} />
            <Stat label="LinkedIn accounts" value={fmt(vol.linkedin_accounts)} />
            <Stat label="Email accounts" value={fmt(vol.email_accounts)} />
          </div>
        </Section>

        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="Email queue" hint="Durable send queue by status.">
            <CountTable rows={(q.by_status ?? []) as Row[]} labelKey="status" countKey="count" />
          </Section>
          <Section title="Campaign runs">
            <CountTable rows={(camp.runs_by_status ?? []) as Row[]} labelKey="status" countKey="count" />
          </Section>
          <Section title="Delivery">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Sent" value={fmt(sent.total)} />
              <Stat label="Delivered" value={fmt(sent.delivered)} />
              <Stat label="Bounced" value={fmt(sent.bounced)} alert={num(sent.bounced) > 0} />
              <Stat label="Complaints" value={fmt(sent.complained)} alert={num(sent.complained) > 0} />
              <Stat label="Senders verified" value={`${fmt(senders.verified)} / ${fmt(senders.total)}`} />
              <Stat label="Senders paused" value={fmt(senders.paused)} alert={num(senders.paused) > 0} />
            </div>
          </Section>
          <Section title="LinkedIn accounts" hint="Session material is never read by this dashboard.">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Total" value={fmt(li?.total)} />
              <Stat label="Authenticated" value={fmt(li?.authenticated)} />
              <Stat label="Needs re-auth" value={fmt(li?.needs_reauth)} alert={num(li?.needs_reauth) > 0} />
            </div>
          </Section>
          <Section title="Track state" hint="Per-channel execution state across all runs.">
            <CountTable rows={(camp.tracks_by_state ?? []) as Row[]} labelKey="state" countKey="count" />
          </Section>
          <Section title="Suppressions">
            <CountTable rows={(del.suppressions_by_kind ?? []) as Row[]} labelKey="kind" countKey="count" />
          </Section>
        </div>

        <Section title="Workers" hint="Singleton leases. A dead lease means that loop is not running.">
          {leases.length === 0 ? (
            <p className="text-[13px] text-base-content/40">No worker leases recorded.</p>
          ) : (
            <ScrollTable headers={["Loop", "Owner", "State", "Heartbeat", "Expires"]}>
              {leases.map((l, i) => (
                <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="px-4 py-2.5 font-medium text-base-content">{text(l.name)}</td>
                  <td className="px-4 py-2.5 text-base-content/55">{text(l.owner_id)}</td>
                  <td className="px-4 py-2.5">{num(l.alive) === 1 ? "alive" : "expired"}</td>
                  <td className="px-4 py-2.5 text-base-content/55">{when(l.heartbeat_at)}</td>
                  <td className="px-4 py-2.5 text-base-content/55">{when(l.expires_at)}</td>
                </tr>
              ))}
            </ScrollTable>
          )}
        </Section>

        <Section title="AI spend" hint="Token and cost ledger. Prompts and generated text are never read.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Generations" value={fmt(aiTotals.generations)} />
            <Stat label="Total cost" value={`$${num(aiTotals.cost_usd).toFixed(4)}`} />
            <Stat label="Input tokens" value={fmt(aiTotals.input_tokens)} />
            <Stat label="Output tokens" value={fmt(aiTotals.output_tokens)} />
          </div>
        </Section>

        <Section title="Workspaces" hint="Per-tenant rollup.">
          <ScrollTable headers={["Workspace", "Members", "Contacts", "Runs", "Active", "LinkedIn", "Email", "Failed", "Uncertain", "AI $", "Last event"]}>
            {(tenants?.workspaces ?? []).map((w, i) => (
              <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-base-content">{text(w.name)}</div>
                  <div className="text-[12px] text-base-content/40">{text(w.slug)}</div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.members)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.contacts)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.runs)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.active_runs)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.linkedin_authenticated)}/{fmt(w.linkedin_accounts)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.email_accounts)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.failed_jobs)}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(w.uncertain_jobs)}</td>
                <td className="px-4 py-2.5 tabular-nums">${num(w.ai_cost_usd).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-base-content/55">{when(w.last_event_at)}</td>
              </tr>
            ))}
          </ScrollTable>
        </Section>

        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="MCP tool usage">
            <ScrollTable headers={["Tool", "Calls", "OK", "Avg ms"]}>
              {((gov.mcp_tools ?? []) as Row[]).map((t, i) => (
                <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="px-4 py-2.5 text-base-content/75">{text(t.tool_name)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(t.calls)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(t.succeeded)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(t.avg_ms)}</td>
                </tr>
              ))}
            </ScrollTable>
          </Section>
          <Section title="Audit activity" hint="Action names only.">
            <CountTable rows={(gov.audit_actions ?? []) as Row[]} labelKey="action" countKey="count" />
          </Section>
        </div>

        <Section title="Recent events" hint="Event type and timing only — payloads are never read.">
          <ScrollTable headers={["Type", "Entity", "Workspace", "When"]}>
            {(overview?.recent_events ?? []).map((e, i) => (
              <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="px-4 py-2.5 text-base-content/75">{text(e.type)}</td>
                <td className="px-4 py-2.5 text-base-content/55">{text(e.entity_type)}</td>
                <td className="px-4 py-2.5 text-base-content/55">{text(e.workspace_id)}</td>
                <td className="px-4 py-2.5 text-base-content/55">{when(e.occurred_at)}</td>
              </tr>
            ))}
          </ScrollTable>
        </Section>

        <p className="pb-4 text-[12px] text-base-content/35">Signed in as {viewer} · instance administrator</p>
      </div>
    </>
  );
}

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const viewer = await getSuperadmin(ctx);
  // 404 rather than a redirect: a normal user should not learn this page exists.
  if (!viewer) return { notFound: true };
  return { props: { viewer } };
}
