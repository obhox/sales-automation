import Head from "next/head";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/router";

type Tab = "overview" | "admin";
type Data = Record<string, unknown>;

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  // Signals and their rules are on /signals.
  // API keys and webhooks are on /developers, CRM and calendar connections on /integrations.
  { id: "admin", label: "Team inbox" },
];

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

export default function PlatformPage() {
  const [tab, setTab] = useState<Tab>("overview");
  // The new sidebar links straight to a tab (?tab=automation) until each tab has its own screen.
  const router = useRouter();
  const requestedTab = router.query.tab;
  useEffect(() => {
    // Deliverability has its own screen now; old links to the tab that held it follow it there.
    if (requestedTab === "deliverability") { void router.replace("/deliverability"); return; }
    // The CRM and calendar tab has its own screen now. Old links to it are sent there.
    if (requestedTab === "integrations") { void router.replace("/integrations"); return; }
    // Signals and their rules have their own screen now. Old links to the tab are sent there.
    if (requestedTab === "automation") { void router.replace("/signals"); return; }
    if (typeof requestedTab === "string" && ["overview", "admin"].includes(requestedTab)) setTab(requestedTab as Tab);
  }, [requestedTab, router]);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Record<string, Data>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    const endpoints: Record<string, string> = {
      workspace: "/api/platform/workspace",
      signals: "/api/platform/signals",
      pipeline: "/api/platform/pipeline", inbox: "/api/platform/inbox",
    };
    const results = await Promise.all(Object.entries(endpoints).map(async ([key, url]) => {
      try { return [key, await api(url)] as const; } catch (error) { return [key, { error: error instanceof Error ? error.message : String(error) }] as const; }
    }));
    setData(Object.fromEntries(results)); setLoading(false);
  }, []);
  useEffect(() => { const timer=setTimeout(()=>void refresh(),0); return()=>clearTimeout(timer); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>, url: string, body: (form: FormData) => unknown, success: string) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(new FormData(form))) });
      form.reset(); toast.success(success); await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }

  const workspace = data.workspace as { workspace?: { id?:string; name?: string }; workspaces?: unknown[]; current_role?: string; members?: unknown[] } | undefined;
  const pipeline = data.pipeline as { stages?: unknown[]; opportunities?: unknown[]; meetings?: unknown[]; revenue?: Record<string, number> } | undefined;
  const inbox = data.inbox as { stats?: Record<string, number>; members?: unknown[]; tags?: unknown[]; saved_replies?: unknown[] } | undefined;
  const stats = useMemo(() => [
    ["Open replies", inbox?.stats?.open ?? 0], ["SLA overdue", inbox?.stats?.overdue ?? 0],
    ["Active signals", arr(data.signals).length], ["Open pipeline", money(pipeline?.revenue?.open_pipeline)],
    ["Won revenue", money(pipeline?.revenue?.won_revenue)], ["Meetings", pipeline?.meetings?.length ?? 0],
  ], [data.signals, inbox, pipeline]);

  return <>
    <Head><title>Platform — Linki</title></Head>
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[13px] font-medium text-base-content/45">{workspace?.workspace?.name ?? "Workspace"} · {workspace?.current_role ?? "member"}</p>
          <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Revenue platform</h1>
          <p className="mt-2 text-[15px] text-base-content/50">Signals, pipeline, and workspace controls.</p>
        </div>
        <button className="inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-base-100 px-3 py-1.5 text-sm font-medium text-base-content/70 transition-colors hover:bg-base-200 disabled:opacity-50" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border-subtle)]">
        {tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${tab === item.id ? "border-primary text-base-content" : "border-transparent text-base-content/45 hover:text-base-content/70"}`}>{item.label}</button>)}
      </div>

      {tab === "overview" && <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{stats.map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]"><div className="text-[13px] text-base-content/45">{label}</div><div className="mt-1.5 text-2xl font-semibold tracking-[-.03em] tabular-nums">{value}</div></div>)}</div>
        <Section title="Pipeline stages"><Table rows={arr(pipeline?.stages)} columns={["name", "opportunity_count", "amount", "weighted_amount"]} /></Section>
        <Section title="Recent meetings"><Table rows={arr(pipeline?.meetings).slice(0, 8)} columns={["title", "contact_name", "starts_at", "provider", "status"]} /></Section>
      </div>}

      {tab === "admin" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Team inbox" subtitle="Tags, saved replies, assignment, collision locks, bulk status, SLA and sentiment filters are enabled.">
          <div className="grid grid-cols-2 gap-2 mb-4"><Mini label="Members" value={arr(inbox?.members).length}/><Mini label="Tags" value={arr(inbox?.tags).length}/><Mini label="Saved replies" value={arr(inbox?.saved_replies).length}/><Mini label="Unassigned" value={inbox?.stats?.unassigned ?? 0}/></div>
          <Form onSubmit={(e)=>submit(e,"/api/platform/inbox",f=>({action:"create_saved_reply",name:f.get("name"),body:f.get("body")}),"Saved reply created")}><Input name="name" placeholder="Saved reply name"/><textarea name="body" className="textarea textarea-bordered w-full" placeholder="Reply text"/><Submit>Save reply</Submit></Form>
        </Section>
      </div>}
    </div>
  </>;
}

function Section({title,subtitle,children}:{title:string;subtitle?:string;children:React.ReactNode}) { return <section className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)]"><h2 className="text-[15px] font-semibold text-base-content">{title}</h2>{subtitle&&<p className="mb-4 mt-1 text-xs text-base-content/45">{subtitle}</p>}<div className={subtitle?"":"mt-4"}>{children}</div></section>; }
function Form({children,onSubmit}:{children:React.ReactNode;onSubmit:(e:FormEvent<HTMLFormElement>)=>void}) { return <form onSubmit={onSubmit} className="mb-4 grid gap-2">{children}</form>; }
function Input(props:React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className="input input-bordered input-sm w-full text-sm"/>; }
function Submit({children}:{children:React.ReactNode}) { return <button className="btn btn-primary btn-sm justify-self-start" type="submit">{children}</button>; }
function Mini({label,value}:{label:string;value:unknown}) { return <div className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3"><div className="text-[11px] text-base-content/45">{label}</div><div className="font-semibold tabular-nums text-base-content">{String(value)}</div></div>; }
function Table({rows,columns}:{rows:unknown[];columns:string[]}) { if(!rows.length) return <p className="py-4 text-xs text-base-content/40">No records yet.</p>; return <div className="overflow-x-auto"><table className="table table-xs"><thead><tr>{columns.map(x=><th key={x} className="text-base-content/45">{x.replaceAll("_"," ")}</th>)}</tr></thead><tbody>{rows.slice(0,100).map((row,i)=><tr key={String((row as Data).id??i)} className="hover:bg-base-200">{columns.map(c=><td key={c} className="max-w-52 truncate">{display((row as Data)[c])}</td>)}</tr>)}</tbody></table></div>; }
/** Records a signal against a contact picked by name. Without a contact a signal is stored but can match no rule. */
function arr(value:unknown):unknown[] { return Array.isArray(value)?value:[]; }
function money(value:unknown) { return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value??0)); }
function display(value:unknown) { if(value===null||value===undefined||value==="") return "—"; if(typeof value==="object") return JSON.stringify(value); return String(value); }