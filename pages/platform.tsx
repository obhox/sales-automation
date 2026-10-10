import Head from "next/head";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, type SignalType } from "@/lib/platform/signal-types";
import RecordPicker, { searchContacts, type PickedRecord } from "@/components/ui/RecordPicker";
import ExportLink from "@/components/ui/ExportLink";

type Tab = "overview" | "deliverability" | "automation" | "integrations" | "admin";
type Data = Record<string, unknown>;

const API_KEY_SCOPES = ["contacts:read", "contacts:write", "campaigns:read", "campaigns:write", "events:read", "events:write", "signals:write", "crm:read", "crm:write", "email:send"];
const DEFAULT_API_KEY_SCOPES = new Set(["contacts:read", "contacts:write", "campaigns:read", "events:read"]);

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "deliverability", label: "Deliverability" },
  { id: "automation", label: "Automation & signals" }, { id: "integrations", label: "CRM & calendar" },
  { id: "admin", label: "Workspace & API" },
];

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

export default function PlatformPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Record<string, Data>>({});
  const [revealedKey, setRevealedKey] = useState("");
  const [revealedInvite, setRevealedInvite] = useState("");
  const [revealedSecret, setRevealedSecret] = useState("");
  const { update: updateSession } = useSession();

  const refresh = useCallback(async () => {
    setLoading(true);
    const endpoints: Record<string, string> = {
      workspace: "/api/platform/workspace", suppressions: "/api/platform/suppressions", deliverability: "/api/platform/deliverability",
      webhooks: "/api/platform/webhooks", signals: "/api/platform/signals", rules: "/api/platform/signal-rules",
      pipeline: "/api/platform/pipeline", connections: "/api/platform/connections", inbox: "/api/platform/inbox",
      apiKeys: "/api/platform/api-keys", audit: "/api/platform/audit",
      invitations: "/api/platform/invitations", emailAccounts: "/api/email-accounts",
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
      const result = await api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(new FormData(form))) });
      if (result?.key) setRevealedKey(result.key);
      if (result?.invite_url) setRevealedInvite(result.invite_url);
      if (result?.secret) setRevealedSecret(result.secret);
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
          <p className="mt-2 text-[15px] text-base-content/50">Deliverability, signals, pipeline, and workspace controls.</p>
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

      {tab === "deliverability" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Domain authentication" subtitle="Live SPF, DKIM, DMARC and MX diagnostics with sender-health scoring.">
          <Form onSubmit={(e) => submit(e, "/api/platform/deliverability", f => ({ action: "check_domain", domain: f.get("domain"), selector: f.get("selector") || "default" }), "Domain checked")}>
            <Input name="domain" placeholder="example.com" required/><Input name="selector" placeholder="DKIM selector (default)"/><Submit>Run checks</Submit>
          </Form><Table rows={arr((data.deliverability as Data)?.latest_checks)} columns={["domain", "score", "spf_status", "dkim_status", "dmarc_status", "mx_status"]}/>
          <Recommendations checks={arr((data.deliverability as Data)?.latest_checks)}/>
        </Section>
        <Section title="Inbox placement test" subtitle="Send an authorized seed message, then record where it landed.">
          <Form onSubmit={(e) => submit(e, "/api/platform/deliverability", f => ({ action: "placement_test", email_account_id: f.get("email_account_id"), seed_email: f.get("seed_email") }), "Placement test sent")}>
            <select name="email_account_id" required defaultValue="" className="select select-bordered select-sm w-full" aria-label="Send from">
              <option value="" disabled>Send from…</option>
              {arr(data.emailAccounts).map((row) => { const x = row as Data; return <option key={String(x.id)} value={String(x.id)}>{String(x.name ?? x.from_email)} · {String(x.from_email)}</option>; })}
            </select>
            <Input name="seed_email" type="email" placeholder="Seed mailbox" required/><Submit>Send test</Submit>
          </Form><PlacementTests rows={arr((data.deliverability as Data)?.placement_tests)} refresh={refresh}/>
        </Section>
        <Section title="Mailbox warmup" subtitle="Reciprocal sending between your configured mailboxes with gradual daily targets."><Table rows={arr((data.deliverability as Data)?.warmup)} columns={["name", "from_email", "enabled", "daily_target", "sent_today"]}/></Section>
        <Section title="Global do-not-contact" subtitle="Checked before every automated or manual email send.">
          <Form onSubmit={(e) => submit(e, "/api/platform/suppressions", f => ({ kind: f.get("kind"), value: f.get("value"), reason: f.get("reason") || "manual" }), "Suppression added")}>
            <Select name="kind" options={["email","domain","linkedin","phone"]}/><Input name="value" placeholder="Address, domain, profile, or phone" required/><Input name="reason" placeholder="Reason"/><Submit>Add DNC</Submit>
          </Form><Suppressions initial={arr(data.suppressions)} canRemoveProtected={["owner","admin"].includes(String(workspace?.current_role))} refresh={refresh}/>
        </Section>
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

      {tab === "integrations" && <div className="space-y-5">
        <div className="grid lg:grid-cols-2 gap-5">
          <Section title="Connect CRM or calendar" subtitle="Tokens are encrypted at rest. Calendar sync uses incremental cursors.">
            <Form onSubmit={(e) => submit(e, "/api/platform/connections", f => ({ provider:f.get("provider"), name:f.get("name"), secret:f.get("secret")||undefined, config: parseJson(String(f.get("config")||"{}")) }), "Connection created")}>
              <Select name="provider" options={["hubspot","salesforce","google_calendar","microsoft_calendar","ical"]}/><Input name="name" placeholder="Connection name" required/><Input name="secret" type="password" placeholder="Access/private-app token"/><textarea className="textarea textarea-bordered w-full text-xs min-h-24" name="config" defaultValue={'{"calendar_id":"primary"}'} /><Submit>Connect</Submit>
            </Form>
          </Section>
          <Section title="Pipeline" subtitle="Opportunities are worked on the pipeline board. Meetings synced from a calendar are tied to the contact's most recent opportunity.">
            <div className="mb-3 grid grid-cols-3 gap-2"><Mini label="Opportunities" value={arr(pipeline?.opportunities).length}/><Mini label="Open" value={money(pipeline?.revenue?.open_pipeline)}/><Mini label="Won" value={money(pipeline?.revenue?.won_revenue)}/></div>
            <Link href="/pipeline" className="btn btn-sm">Open the pipeline board</Link>
          </Section>
        </div>
        <Section title="Connections"><Connections rows={arr(data.connections)} refresh={refresh}/></Section>
      </div>}

      {tab === "admin" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Workspace members" subtitle="Invite collaborators to share outreach, assign work, manage campaigns, and review replies.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/invitations",f=>({email:f.get("email"),role:f.get("role"),send_email:true}),"Invitation created")}><Input name="email" type="email" placeholder="teammate@example.com" required/><Select name="role" options={["member","manager","viewer","admin","owner"]}/><Submit>Invite teammate</Submit></Form>
          {revealedInvite&&<div className="mb-4 rounded-[10px] border border-[var(--border)] bg-base-200 p-3"><div className="mb-1 text-xs text-base-content/55">Copy invitation link</div><button type="button" className="select-all break-all text-left text-xs text-base-content" onClick={()=>{void navigator.clipboard.writeText(revealedInvite);toast.success("Invitation link copied");}}>{revealedInvite}</button></div>}
          <Members rows={arr(workspace?.members)} currentRole={workspace?.current_role} refresh={refresh}/>
          <h3 className="mb-2 mt-5 text-[13px] font-semibold text-base-content">Invitations</h3><Invitations rows={arr((data.invitations as Data)?.invitations)} refresh={refresh}/>
        </Section>
        <Section title="Your workspaces" subtitle="Switch between outreach workspaces you own or have joined."><WorkspacePicker rows={arr(workspace?.workspaces)} active={String(workspace?.workspace?.id??"")} onSwitch={async id=>{await updateSession({workspaceId:id});window.location.reload();}}/></Section>
        <Section title="Team inbox" subtitle="Tags, saved replies, assignment, collision locks, bulk status, SLA and sentiment filters are enabled.">
          <div className="grid grid-cols-2 gap-2 mb-4"><Mini label="Members" value={arr(inbox?.members).length}/><Mini label="Tags" value={arr(inbox?.tags).length}/><Mini label="Saved replies" value={arr(inbox?.saved_replies).length}/><Mini label="Unassigned" value={inbox?.stats?.unassigned ?? 0}/></div>
          <Form onSubmit={(e)=>submit(e,"/api/platform/inbox",f=>({action:"create_saved_reply",name:f.get("name"),body:f.get("body")}),"Saved reply created")}><Input name="name" placeholder="Saved reply name"/><textarea name="body" className="textarea textarea-bordered w-full" placeholder="Reply text"/><Submit>Save reply</Submit></Form>
        </Section>
        <Section title="Public API keys" subtitle="The secret is shown once and stored only as a hash. Pick the narrowest scopes that work — e.g. an analytics platform like Falorb only ever needs read scopes.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/api-keys",f=>({name:f.get("name"),scopes:API_KEY_SCOPES.filter(s=>f.get(`scope_${s}`)),expires_at:f.get("expires_at")?`${f.get("expires_at")} 23:59:59`:undefined}),"API key created")}>
            <Input name="name" placeholder="Key name (e.g. Falorb)" required/>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
              {API_KEY_SCOPES.map(s=><label key={s} className="flex items-center gap-1.5 text-xs text-base-content/70"><input type="checkbox" name={`scope_${s}`} defaultChecked={DEFAULT_API_KEY_SCOPES.has(s)} className="checkbox checkbox-xs"/>{s}</label>)}
            </div>
            <label className="grid gap-1 text-xs text-base-content/55">Expires (optional — never expires if left blank)<Input name="expires_at" type="date"/></label>
            <Submit>Create key</Submit>
          </Form>
          {revealedKey && <div className="mt-3 mb-4 rounded-lg bg-warning/10 border border-warning/30 p-3">
            <div className="text-xs text-warning mb-1">Copy now — it will not be shown again</div>
            <div className="flex items-center gap-2"><code className="flex-1 text-xs break-all select-all">{revealedKey}</code>
              <button type="button" className="btn btn-xs shrink-0" onClick={()=>{void navigator.clipboard.writeText(revealedKey);toast.success("Key copied");}}>Copy</button>
            </div>
          </div>}
          <ApiKeys rows={arr(data.apiKeys)} refresh={refresh}/>
        </Section>
        <Section title="Signed webhooks" subtitle="HMAC-SHA256 deliveries retry with exponential backoff and move to a dead-letter state after eight attempts.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/webhooks",f=>{const picked=f.getAll("event").map(String);return{url:f.get("url"),event_types:picked.length?picked:"*"};},"Webhook created")}>
            <Input name="url" type="url" placeholder="https://…" required/>
            <fieldset className="rounded-[10px] border border-[var(--border-subtle)] p-3">
              <legend className="px-1 text-[11px] text-base-content/45">Events to send (none ticked sends all)</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">{EVENT_TYPES.map(type=><label key={type} className="flex items-center gap-1.5 text-xs text-base-content/70"><input type="checkbox" name="event" value={type} className="checkbox checkbox-xs"/>{type}</label>)}</div>
            </fieldset>
            <Submit>Add endpoint</Submit>
          </Form>
          {revealedSecret && <div className="mt-3 mb-4 rounded-lg bg-warning/10 border border-warning/30 p-3">
            <div className="text-xs text-warning mb-1">Signing secret. Copy it now — it will not be shown again</div>
            <div className="flex items-center gap-2"><code className="flex-1 text-xs break-all select-all">{revealedSecret}</code>
              <button type="button" className="btn btn-xs shrink-0" onClick={()=>{void navigator.clipboard.writeText(revealedSecret);toast.success("Secret copied");}}>Copy</button>
            </div>
          </div>}
          <Webhooks rows={arr(data.webhooks)} refresh={refresh}/>
        </Section>
        <Section title="Audit log"><Table rows={arr(data.audit).slice(0,25)} columns={["action","entity_type","user_email","ip_address","created_at"]}/></Section>
      </div>}
    </div>
  </>;
}

function Section({title,subtitle,children}:{title:string;subtitle?:string;children:React.ReactNode}) { return <section className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)]"><h2 className="text-[15px] font-semibold text-base-content">{title}</h2>{subtitle&&<p className="mb-4 mt-1 text-xs text-base-content/45">{subtitle}</p>}<div className={subtitle?"":"mt-4"}>{children}</div></section>; }
function Form({children,onSubmit}:{children:React.ReactNode;onSubmit:(e:FormEvent<HTMLFormElement>)=>void}) { return <form onSubmit={onSubmit} className="mb-4 grid gap-2">{children}</form>; }
function Input(props:React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className="input input-bordered input-sm w-full text-sm"/>; }
function Select({name,options}:{name:string;options:string[]}) { return <select name={name} className="select select-bordered select-sm w-full">{options.map(x=><option key={x} value={x}>{x.replaceAll("_"," ")}</option>)}</select>; }
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
function Recommendations({checks}:{checks:unknown[]}) {
  const items=checks.flatMap((row)=>{const x=row as Data;try{const list=(JSON.parse(String(x.details_json??"{}")) as {recommendations?:string[]}).recommendations??[];return list.length?[{domain:String(x.domain),list}]:[];}catch{return [];}});
  if(!items.length) return null;
  return <div className="mt-3 space-y-2">{items.map((item)=><div key={item.domain} className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
    <div className="text-xs font-medium text-base-content">To fix on {item.domain}</div>
    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-base-content/60">{item.list.map((line)=><li key={line}>{line}</li>)}</ul>
  </div>)}</div>;
}

const PLACEMENTS = ["inbox","promotions","spam","missing"];
/** Placement tests, each with where the seed message turned up once somebody has looked. */
function PlacementTests({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) {
  async function record(id:string,placement:string){
    try{await api("/api/platform/deliverability",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"mark_placement",id,placement})});toast.success("Result recorded");await refresh();}
    catch(e){toast.error(e instanceof Error?e.message:String(e));}
  }
  if(!rows.length) return <p className="py-4 text-xs text-base-content/40">No placement tests yet.</p>;
  return <div className="space-y-2">{rows.slice(0,20).map((row,i)=>{const x=row as Data;return <div key={String(x.id??i)} className="flex items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
    <div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{String(x.seed_email)}</div><div className="truncate text-[11px] text-base-content/45">{String(x.subject)} · sent {String(x.sent_at??"").slice(0,16)}</div></div>
    <select value={String(x.placement??"")} onChange={e=>{if(e.target.value)void record(String(x.id),e.target.value);}} aria-label="Where it landed" className="rounded-md border border-[var(--border)] bg-base-100 px-2 py-1 text-xs">
      <option value="">Where did it land?</option>{PLACEMENTS.map(p=><option key={p} value={p}>{p}</option>)}
    </select>
  </div>;})}</div>;
}

/** The do-not-contact list: search it, remove from it, and add many entries at once. */
function Suppressions({initial,canRemoveProtected,refresh}:{initial:unknown[];canRemoveProtected:boolean;refresh:()=>Promise<void>}) {
  const [q,setQ]=useState(""); const [kind,setKind]=useState(""); const [found,setFound]=useState<unknown[]|null>(null);
  const [importing,setImporting]=useState(false); const [entries,setEntries]=useState(""); const [outcome,setOutcome]=useState<{added:number;already_listed:number;invalid:string[]}|null>(null);
  const rows=found??initial;
  const search=useCallback(async(nextQ:string,nextKind:string)=>{
    if(!nextQ&&!nextKind){setFound(null);return;}
    try{setFound(await api(`/api/platform/suppressions?${new URLSearchParams({q:nextQ,kind:nextKind})}`));}catch(e){toast.error(e instanceof Error?e.message:String(e));}
  },[]);
  async function remove(x:Data){
    if(!confirm(`Remove ${String(x.value)} from the do-not-contact list? It can be contacted again.`))return;
    try{await api(`/api/platform/suppressions?id=${encodeURIComponent(String(x.id))}`,{method:"DELETE"});toast.success("Removed");await refresh();await search(q,kind);}
    catch(e){toast.error(e instanceof Error?e.message:String(e));}
  }
  async function runImport(){
    try{const result=await api("/api/platform/suppressions/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({entries})});setOutcome(result);setEntries("");await refresh();await search(q,kind);}
    catch(e){toast.error(e instanceof Error?e.message:String(e));}
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <input value={q} onChange={e=>{setQ(e.target.value);void search(e.target.value,kind);}} placeholder="Search the list" aria-label="Search the do-not-contact list" className="input input-bordered input-sm min-w-0 flex-1 text-sm"/>
      <select value={kind} onChange={e=>{setKind(e.target.value);void search(q,e.target.value);}} aria-label="Kind" className="select select-bordered select-sm"><option value="">All kinds</option>{["email","domain","linkedin","phone"].map(k=><option key={k}>{k}</option>)}</select>
      <button type="button" className="btn btn-ghost btn-sm" onClick={()=>{setImporting(v=>!v);setOutcome(null);}}>{importing?"Close import":"Import a list"}</button>
      {rows.length>0&&<ExportLink resource="suppressions" params={Object.fromEntries(Object.entries({q,kind}).filter(([,value])=>value))}/>}
    </div>
    {importing&&<div className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
      <textarea value={entries} onChange={e=>setEntries(e.target.value)} rows={5} placeholder={"One per line: an email address, a domain, a LinkedIn profile or a phone number.\nA pasted CSV works too; the first column is used."} aria-label="Entries to import" className="textarea textarea-bordered w-full text-xs"/>
      <div className="mt-2 flex items-center gap-3"><button type="button" className="btn btn-primary btn-sm" disabled={!entries.trim()} onClick={()=>void runImport()}>Import</button>
        {outcome&&<span className="text-xs text-base-content/60">{outcome.added} added, {outcome.already_listed} already listed{outcome.invalid.length?`, ${outcome.invalid.length} not recognised: ${outcome.invalid.slice(0,3).join(", ")}${outcome.invalid.length>3?"…":""}`:""}</span>}
      </div>
    </div>}
    {!rows.length?<p className="py-4 text-xs text-base-content/40">{found?"Nothing matches.":"Nobody is on the list yet."}</p>:
    <div className="space-y-1.5">{rows.slice(0,100).map((row,i)=>{const x=row as Data;const guarded=["unsubscribe","unsubscribed","complained","bounced"].includes(String(x.reason))||["reply_classifier","bounce"].includes(String(x.source??""));return <div key={String(x.id??i)} className="flex items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 px-3 py-2">
      <div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{String(x.value)}</div><div className="truncate text-[11px] text-base-content/45">{String(x.kind)} · {String(x.reason)}{x.source?` · ${String(x.source)}`:""} · {String(x.created_at??"").slice(0,10)}</div></div>
      <button type="button" disabled={guarded&&!canRemoveProtected} title={guarded&&!canRemoveProtected?"Only an admin can remove an entry that came from an unsubscribe, a complaint or a bounce":undefined} onClick={()=>void remove(x)} className="btn btn-ghost btn-xs text-error disabled:text-base-content/30">Remove</button>
    </div>;})}{rows.length>100&&<p className="text-[11px] text-base-content/40">Showing the first 100. Search to find the rest.</p>}</div>}
  </div>;
}

/** Webhook endpoints: on or off, a test, what was delivered and how it was answered, and removal. */
function Webhooks({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState(""); const [open,setOpen]=useState(""); const [log,setLog]=useState<unknown[]>([]);
  const call=async(body:unknown,method="PATCH")=>api("/api/platform/webhooks",{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  async function showLog(id:string){ if(open===id){setOpen("");return;} try{setLog(await api(`/api/platform/webhooks?deliveries=${encodeURIComponent(id)}`));setOpen(id);}catch(e){toast.error(e instanceof Error?e.message:String(e));} }
  async function act(id:string,fn:()=>Promise<unknown>,done:(result:unknown)=>string){setBusy(id);try{toast.success(done(await fn()));await refresh();if(open===id)setLog(await api(`/api/platform/webhooks?deliveries=${encodeURIComponent(id)}`));}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setBusy("");}}
  if(!rows.length) return <p className="py-4 text-xs text-base-content/40">No webhooks yet.</p>;
  return <div className="space-y-2">{rows.map((row,i)=>{const x=row as Data;const id=String(x.id??i);const enabled=Boolean(x.enabled);return <div key={id} className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{String(x.url)}</div><div className="truncate text-[11px] text-base-content/45">{String(x.event_types)==="*"?"all events":String(x.event_types).replaceAll(",",", ")} · {String(x.delivery_count??0)} deliveries{Number(x.dead_letters)>0?` · ${String(x.dead_letters)} given up on`:""}</div></div>
      <button type="button" disabled={busy===id} aria-pressed={enabled} onClick={()=>void act(id,()=>call({id,enabled:!enabled}),()=>enabled?"Webhook turned off":"Webhook turned on")} className="btn btn-ghost btn-xs">{enabled?"On":"Off"}</button>
      <button type="button" disabled={busy===id||!enabled} onClick={()=>void act(id,()=>call({id},"PUT"),(result)=>{const d=((result as {deliveries?:Array<{status:string;last_error:string|null}>}).deliveries??[])[0];return d?.status==="delivered"?"Test delivered":`Test not delivered: ${d?.last_error??"no answer"}`;})} className="btn btn-ghost btn-xs">Test</button>
      <button type="button" onClick={()=>void showLog(id)} className="btn btn-ghost btn-xs">{open===id?"Hide log":"Log"}</button>
      <button type="button" disabled={busy===id} onClick={()=>{if(confirm("Delete this webhook? Its delivery history goes with it."))void act(id,()=>api(`/api/platform/webhooks?id=${encodeURIComponent(id)}`,{method:"DELETE"}),()=>"Webhook deleted");}} className="btn btn-ghost btn-xs text-error">Delete</button>
    </div>
    {open===id&&<div className="mt-2 space-y-1 border-t border-[var(--border-subtle)] pt-2">{log.length===0?<p className="text-[11px] text-base-content/40">Nothing has been sent to this endpoint yet.</p>:log.map((entry,n)=>{const d=entry as Data;const ok=d.status==="delivered";return <div key={String(d.id??n)} className="flex items-center gap-2 text-[11px]">
      <span className={`w-16 shrink-0 font-medium ${ok?"text-success":d.status==="dead_letter"?"text-error":"text-base-content/55"}`}>{d.status==="dead_letter"?"gave up":String(d.status)}</span>
      <span className="w-32 shrink-0 truncate text-base-content/70">{String(d.event_type)}</span>
      <span className="min-w-0 flex-1 truncate text-base-content/45">{d.response_status?`HTTP ${String(d.response_status)} · `:""}{ok?`delivered ${String(d.delivered_at??"").slice(0,16)}`:String(d.last_error??`attempt ${String(d.attempt)}`)}</span>
      {!ok&&d.status!=="pending"&&<button type="button" disabled={busy===id} onClick={()=>void act(id,()=>call({delivery_id:d.id},"PUT"),(result)=>(result as {status?:string}).status==="delivered"?"Delivered":"Still not delivered")} className="btn btn-ghost btn-xs shrink-0">Send again</button>}
    </div>;})}</div>}
  </div>;})}</div>;
}

function ApiKeys({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) {
  async function revoke(id:string){
    if(!window.confirm("Revoke this key? Anything using it — including Falorb — will lose access immediately."))return;
    try{await api(`/api/platform/api-keys?id=${encodeURIComponent(id)}`,{method:"DELETE"});toast.success("Key revoked");await refresh();}
    catch(e){toast.error(e instanceof Error?e.message:String(e));}
  }
  if(!rows.length) return <p className="py-4 text-xs text-base-content/40">No API keys yet.</p>;
  return <div className="space-y-2">{rows.map((row,i)=>{
    const x=row as Data;
    const revoked=Boolean(x.revoked_at);
    const expired=!revoked&&typeof x.expires_at==="string"&&new Date(x.expires_at)<new Date();
    const status=revoked?"Revoked":expired?"Expired":"Active";
    const statusClass=revoked||expired?"bg-base-200 text-base-content/40":"bg-success/10 text-success";
    return <div key={String(x.id??i)} className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="text-sm font-medium text-base-content">{String(x.name)}</span><span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusClass}`}>{status}</span></div>
          <div className="mt-1 text-xs text-base-content/45">{String(x.key_prefix)}… · {String(x.scopes)}</div>
          <div className="mt-0.5 text-[11px] text-base-content/40">{x.last_used_at?`last used ${String(x.last_used_at)}`:"never used"}{x.expires_at?` · expires ${String(x.expires_at)}`:""}</div>
        </div>
        {!revoked&&<button type="button" className="btn btn-ghost btn-xs text-error shrink-0" onClick={()=>void revoke(String(x.id))}>Revoke</button>}
      </div>
    </div>;
  })}</div>;
}
function Connections({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) { const [busy,setBusy]=useState(""); async function sync(id:string){setBusy(id);try{await api("/api/platform/connections",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({id})});toast.success("Sync complete");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setBusy("");}} return <div className="space-y-2">{rows.map((r,i)=>{const x=r as Data;return <div key={String(x.id??i)} className="flex items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium text-base-content">{String(x.name)}</div><div className="text-xs text-base-content/45">{String(x.provider)} · {x.sync_error?String(x.sync_error):x.last_synced_at?`synced ${String(x.last_synced_at)}`:"never synced"}</div></div><button className="btn btn-xs" onClick={()=>void sync(String(x.id))} disabled={busy===x.id}>{busy===x.id?"Syncing…":"Sync now"}</button></div>})}</div>; }
const MEMBER_ROLES = ["owner","admin","manager","member","viewer"];
function Members({rows,currentRole,refresh}:{rows:unknown[];currentRole?:string;refresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState("");
  const canManage = currentRole==="owner" || currentRole==="admin";
  async function changeRole(email:string,role:string){setBusy(email);try{await api("/api/platform/workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,role})});toast.success("Role updated");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setBusy("");}}
  async function remove(id:string,email:string){if(!confirm(`Remove ${email} from this workspace? They lose all access.`))return;setBusy(id);try{await api(`/api/platform/workspace?user_id=${encodeURIComponent(id)}`,{method:"DELETE"});toast.success("Member removed");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setBusy("");}}
  if(!rows.length) return <p className="py-2 text-xs text-base-content/40">No members yet.</p>;
  return <div className="space-y-2">{rows.map((row,i)=>{const x=row as Data;const id=String(x.id??"");const email=String(x.email??"");const role=String(x.role??"member");return (
    <div key={id||i} className="flex items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
      <div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{email}</div><div className="text-[11px] text-base-content/45">joined {String(x.created_at ?? "").slice(0,10)}</div></div>
      {canManage ? (
        <select disabled={busy===email} value={role} onChange={e=>void changeRole(email,e.target.value)} title={currentRole!=="owner"?"Only an owner can grant owner access":undefined} className="rounded-md border border-[var(--border)] bg-base-100 px-2 py-1 text-xs">
          {MEMBER_ROLES.map(r=><option key={r} value={r} disabled={r==="owner"&&currentRole!=="owner"}>{r}</option>)}
        </select>
      ) : <span className="rounded bg-base-100 px-2 py-0.5 text-xs capitalize text-base-content/60">{role}</span>}
      {canManage && <button type="button" disabled={busy===id} onClick={()=>void remove(id,email)} className="btn btn-ghost btn-xs text-error">Remove</button>}
    </div>);})}</div>;
}
function Invitations({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) { async function revoke(id:string){try{await api(`/api/platform/invitations?id=${encodeURIComponent(id)}`,{method:"DELETE"});toast.success("Invitation revoked");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}} return <div className="space-y-2">{rows.length===0&&<p className="py-2 text-xs text-base-content/40">No invitations yet.</p>}{rows.slice(0,20).map((row,i)=>{const x=row as Data;return <div key={String(x.id??i)} className="flex items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3"><div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{String(x.email)}</div><div className="text-[11px] text-base-content/45">{String(x.role)} · {String(x.status)}</div></div>{x.status==="pending"&&<button type="button" className="btn btn-ghost btn-xs text-error" onClick={()=>void revoke(String(x.id))}>Revoke</button>}</div>})}</div>; }
function WorkspacePicker({rows,active,onSwitch}:{rows:unknown[];active:string;onSwitch:(id:string)=>Promise<void>}) { const [busy,setBusy]=useState("");return <div className="space-y-2">{rows.map((row,i)=>{const x=row as Data;const id=String(x.id??"");return <button type="button" key={id||i} disabled={id===active||busy!==""} onClick={async()=>{setBusy(id);try{await onSwitch(id);}catch(e){toast.error(e instanceof Error?e.message:String(e));setBusy("");}}} className={`flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition-colors ${id===active?"border-[var(--border-strong)] bg-base-200":"border-[var(--border-subtle)] hover:bg-base-200"}`}><div className="flex-1"><div className="text-sm font-medium text-base-content">{String(x.name)}</div><div className="text-xs text-base-content/45">{String(x.role)}</div></div><span className="text-xs text-base-content/60">{id===active?"Current":busy===id?"Switching…":"Switch"}</span></button>})}</div>; }
function arr(value:unknown):unknown[] { return Array.isArray(value)?value:[]; }
function money(value:unknown) { return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value??0)); }
function display(value:unknown) { if(value===null||value===undefined||value==="") return "—"; if(typeof value==="object") return JSON.stringify(value); return String(value); }
function parseJson(value:string) { try{return JSON.parse(value);}catch{throw new Error("Configuration must be valid JSON");} }
