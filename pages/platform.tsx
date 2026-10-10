import Head from "next/head";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/router";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, type SignalType } from "@/lib/platform/signal-types";
import RecordPicker, { searchContacts, type PickedRecord } from "@/components/ui/RecordPicker";

type Tab = "overview" | "automation" | "admin";
type Data = Record<string, unknown>;

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "automation", label: "Automation & signals" },
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
    if (typeof requestedTab === "string" && ["overview", "automation", "admin"].includes(requestedTab)) setTab(requestedTab as Tab);
  }, [requestedTab, router]);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Record<string, Data>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    const endpoints: Record<string, string> = {
      workspace: "/api/platform/workspace",
      signals: "/api/platform/signals", rules: "/api/platform/signal-rules",
      pipeline: "/api/platform/pipeline", inbox: "/api/platform/inbox",
      emailAccounts: "/api/email-accounts",
      lists: "/api/lists", workflows: "/api/workflows", accounts: "/api/accounts",
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

      {tab === "automation" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Record a signal" subtitle="A job change, funding round, hiring push, technology or product-intent event. It raises the contact's intent score and sets off any rule it matches.">
          <RecordSignal refresh={refresh}/><Table rows={arr(data.signals).slice(0,20)} columns={["type","title","score","source","occurred_at"]}/>
        </Section>
        <Section title="Signal rules" subtitle="When a signal of a kind arrives for a contact, add them to a list, enrol them in a campaign, or both.">
          <SignalRules rows={arr(data.rules)} lists={arr(data.lists)} workflows={arr(data.workflows)} accounts={arr(data.accounts)} mailboxes={arr(data.emailAccounts)} canManage={["owner","admin","manager"].includes(String(workspace?.current_role))} refresh={refresh}/>
        </Section>
        <Section title="Conditional workflows" subtitle="Campaign steps can branch on connection, reply, email availability, intent score, signals, target fields, and custom fields."><p className="text-sm text-base-content/55">Branches are available in the workflow API and MCP tools. Branch targets are validated as forward-only to prevent accidental loops.</p></Section>
        <Section title="Reply intelligence" subtitle="Positive, negative, out-of-office, unsubscribe, and human-review classification."><div className="grid grid-cols-2 gap-2">{["positive","negative","out_of_office","unsubscribe","human_review"].map(k=><div key={k} className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 px-3 py-2 text-xs text-base-content/70">{k.replaceAll("_"," ")}</div>)}</div></Section>
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
function RecordSignal({refresh}:{refresh:()=>Promise<void>}) {
  const [contact,setContact]=useState<PickedRecord|null>(null);
  async function record(event:FormEvent<HTMLFormElement>){
    event.preventDefault(); const form=event.currentTarget; const f=new FormData(form);
    try{
      await api("/api/platform/signals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:f.get("type"),title:f.get("title"),target_id:contact?.id,score:Number(f.get("score")||0),source:"manual"})});
      form.reset(); setContact(null); toast.success(contact?"Signal recorded":"Signal recorded. With no contact it matches no rule."); await refresh();
    }catch(e){toast.error(e instanceof Error?e.message:String(e));}
  }
  return <Form onSubmit={record}>
    <select name="type" className="select select-bordered select-sm w-full" aria-label="Kind of signal">{SIGNAL_TYPES.map(type=><option key={type} value={type}>{SIGNAL_TYPE_LABELS[type]}</option>)}</select>
    <Input name="title" placeholder="What happened, e.g. Raised a Series B" required/>
    <RecordPicker size="sm" label="Contact" placeholder="Contact it is about…" value={contact} onChange={setContact} search={searchContacts}/>
    <Input name="score" type="number" min="0" max="100" placeholder="Score, 0 to 100"/><Submit>Record signal</Submit>
  </Form>;
}

interface RuleDraft { id:string; name:string; signal_type:string; min_score:string; list_id:string; workflow_id:string; account_id:string; email_account_id:string; auto_start:boolean }
const NEW_RULE:RuleDraft={id:"",name:"",signal_type:"job_change",min_score:"0",list_id:"",workflow_id:"",account_id:"",email_account_id:"",auto_start:false};
const signalLabel=(type:unknown)=>SIGNAL_TYPE_LABELS[String(type) as SignalType]??String(type);

function SignalRules({rows,lists,workflows,accounts,mailboxes,canManage,refresh}:{rows:unknown[];lists:unknown[];workflows:unknown[];accounts:unknown[];mailboxes:unknown[];canManage:boolean;refresh:()=>Promise<void>}) {
  const [draft,setDraft]=useState<RuleDraft|null>(null); const [busy,setBusy]=useState("");
  const set=(change:Partial<RuleDraft>)=>setDraft(current=>current?{...current,...change}:current);
  const call=(method:string,body:unknown)=>api("/api/platform/signal-rules",{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  async function act(id:string,work:()=>Promise<unknown>,done:string){setBusy(id);try{await work();toast.success(done);await refresh();return true;}catch(e){toast.error(e instanceof Error?e.message:String(e));return false;}finally{setBusy("");}}
  async function save(event:FormEvent){
    event.preventDefault(); if(!draft) return;
    const body={name:draft.name,signal_type:draft.signal_type,min_score:Number(draft.min_score||0),list_id:draft.list_id||null,workflow_id:draft.workflow_id||null,account_id:draft.account_id||null,email_account_id:draft.email_account_id||null,auto_start:draft.auto_start};
    if(await act(draft.id||"new",()=>draft.id?call("PATCH",{id:draft.id,...body}):call("POST",body),draft.id?"Rule saved":"Rule added")) setDraft(null);
  }
  const edit=(r:Data)=>setDraft({id:String(r.id),name:String(r.name??""),signal_type:String(r.signal_type??"custom"),min_score:String(r.min_score??0),list_id:String(r.list_id??""),workflow_id:String(r.workflow_id??""),account_id:String(r.account_id??""),email_account_id:String(r.email_account_id??""),auto_start:Boolean(r.auto_start)});
  const pick=(label:string,value:string,onChange:(value:string)=>void,options:unknown[],none:string,name=(x:Data)=>String(x.name??x.id))=><label className="block"><span className="mb-1 block text-[11px] text-base-content/45">{label}</span><select className="select select-bordered select-sm w-full" value={value} onChange={e=>onChange(e.target.value)}><option value="">{none}</option>{options.map(row=>{const x=row as Data;return <option key={String(x.id)} value={String(x.id)}>{name(x)}</option>;})}</select></label>;
  return <div>
    {canManage&&!draft&&<button type="button" className="btn btn-sm mb-4" onClick={()=>setDraft(NEW_RULE)}>New rule</button>}
    {!canManage&&<p className="mb-3 text-xs text-base-content/45">A manager can add and change rules.</p>}
    {draft&&<form onSubmit={save} className="mb-4 grid gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
      <label className="block"><span className="mb-1 block text-[11px] text-base-content/45">Rule name</span><input className="input input-bordered input-sm w-full text-sm" value={draft.name} onChange={e=>set({name:e.target.value})} placeholder="e.g. New funding goes to the founders campaign" required/></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-[11px] text-base-content/45">When a signal is</span><select className="select select-bordered select-sm w-full" value={draft.signal_type} onChange={e=>set({signal_type:e.target.value})}>{SIGNAL_TYPES.map(type=><option key={type} value={type}>{SIGNAL_TYPE_LABELS[type]}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-[11px] text-base-content/45">Scoring at least</span><input className="input input-bordered input-sm w-full text-sm" type="number" min="0" step="any" value={draft.min_score} onChange={e=>set({min_score:e.target.value})}/></label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {pick("Add the contact to",draft.list_id,value=>set({list_id:value}),lists,"No list")}
        {pick("Enrol them in",draft.workflow_id,value=>set({workflow_id:value}),workflows,"No campaign")}
      </div>
      {draft.workflow_id&&<>
        <div className="grid grid-cols-2 gap-3">
          {pick("LinkedIn account",draft.account_id,value=>set({account_id:value}),accounts,"None")}
          {pick("Mailbox",draft.email_account_id,value=>set({email_account_id:value}),mailboxes,"None",x=>`${String(x.name??x.from_email)} · ${String(x.from_email)}`)}
        </div>
        <p className="text-[11px] text-base-content/45">A campaign with LinkedIn steps runs from the LinkedIn account; its emails, if it has any, go from the mailbox. An email-only campaign needs just the mailbox.</p>
        <label className="flex items-start gap-2 text-xs text-base-content/70"><input type="checkbox" className="checkbox checkbox-xs mt-0.5" checked={draft.auto_start} onChange={e=>set({auto_start:e.target.checked})}/><span>Start the campaign by itself on the first match. Left unticked, the run is created and waits for someone to start it.</span></label>
      </>}
      <div className="flex gap-2"><button type="submit" disabled={busy!==""} className="btn btn-primary btn-sm">{draft.id?"Save rule":"Add rule"}</button><button type="button" className="btn btn-ghost btn-sm" onClick={()=>setDraft(null)}>Cancel</button></div>
    </form>}
    {rows.length===0?<p className="py-4 text-xs text-base-content/40">No signal rules yet.</p>:<div className="space-y-2">{rows.map((row,i)=>{const r=row as Data;const id=String(r.id??i);const enabled=Boolean(r.enabled);const problem=typeof r.problem==="string"?r.problem:"";
      const then=[r.list_id?`add to ${display(r.list_name)}`:"",r.workflow_id?`enrol in ${display(r.workflow_name)}${[r.account_name,r.email_account_name].filter(Boolean).length?` from ${[r.account_name,r.email_account_name].filter(Boolean).join(" and ")}`:""}`:""].filter(Boolean).join(", ")||"nothing";
      return <div key={id} className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-base-content">{display(r.name)}</div><div className="text-[11px] text-base-content/50">{signalLabel(r.signal_type)} scoring {display(r.min_score)} or more: {then}{r.workflow_id?(r.auto_start?" · starts by itself":" · waits to be started"):""}</div></div>
          {canManage?<>
            <button type="button" disabled={busy===id} aria-pressed={enabled} onClick={()=>void act(id,()=>call("PATCH",{id,enabled:!enabled}),enabled?"Rule turned off":"Rule turned on")} className="btn btn-ghost btn-xs">{enabled?"On":"Off"}</button>
            <button type="button" onClick={()=>edit(r)} className="btn btn-ghost btn-xs">Edit</button>
            <button type="button" disabled={busy===id} onClick={()=>{if(confirm("Delete this rule? Contacts it already enrolled stay in their campaign."))void act(id,()=>api(`/api/platform/signal-rules?id=${encodeURIComponent(id)}`,{method:"DELETE"}),"Rule deleted");}} className="btn btn-ghost btn-xs text-error">Delete</button>
          </>:<span className="text-[11px] text-base-content/45">{enabled?"On":"Off"}</span>}
        </div>
        {problem&&<p className="mt-2 border-t border-[var(--border-subtle)] pt-2 text-[11px] text-warning">{enabled?"Not working: ":"Before it can be turned on: "}{problem}</p>}
      </div>;})}</div>}
  </div>;
}
/** What the last check of each domain says to fix. */
/** Webhook endpoints: on or off, a test, what was delivered and how it was answered, and removal. */
function arr(value:unknown):unknown[] { return Array.isArray(value)?value:[]; }
function money(value:unknown) { return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value??0)); }
function display(value:unknown) { if(value===null||value===undefined||value==="") return "—"; if(typeof value==="object") return JSON.stringify(value); return String(value); }