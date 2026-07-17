import Head from "next/head";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";

type Tab = "overview" | "deliverability" | "automation" | "integrations" | "admin";
type Data = Record<string, unknown>;

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
  const { update: updateSession } = useSession();

  const refresh = useCallback(async () => {
    setLoading(true);
    const endpoints: Record<string, string> = {
      workspace: "/api/platform/workspace", suppressions: "/api/platform/suppressions", deliverability: "/api/platform/deliverability",
      webhooks: "/api/platform/webhooks", signals: "/api/platform/signals", rules: "/api/platform/signal-rules",
      pipeline: "/api/platform/pipeline", connections: "/api/platform/connections", inbox: "/api/platform/inbox",
      apiKeys: "/api/platform/api-keys", audit: "/api/platform/audit",
      invitations: "/api/platform/invitations",
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
        </Section>
        <Section title="Inbox placement test" subtitle="Send an authorized seed message, then record where it landed.">
          <Form onSubmit={(e) => submit(e, "/api/platform/deliverability", f => ({ action: "placement_test", email_account_id: f.get("email_account_id"), seed_email: f.get("seed_email") }), "Placement test sent")}>
            <Input name="email_account_id" placeholder="Email account ID" required/><Input name="seed_email" type="email" placeholder="Seed mailbox" required/><Submit>Send test</Submit>
          </Form><Table rows={arr((data.deliverability as Data)?.placement_tests)} columns={["seed_email", "status", "placement", "sent_at"]}/>
        </Section>
        <Section title="Mailbox warmup" subtitle="Reciprocal sending between your configured mailboxes with gradual daily targets."><Table rows={arr((data.deliverability as Data)?.warmup)} columns={["name", "from_email", "enabled", "daily_target", "sent_today"]}/></Section>
        <Section title="Global do-not-contact" subtitle="Checked before every automated or manual email send.">
          <Form onSubmit={(e) => submit(e, "/api/platform/suppressions", f => ({ kind: f.get("kind"), value: f.get("value"), reason: f.get("reason") || "manual" }), "Suppression added")}>
            <Select name="kind" options={["email","domain","linkedin","phone"]}/><Input name="value" placeholder="Address, domain, profile, or phone" required/><Input name="reason" placeholder="Reason"/><Submit>Add DNC</Submit>
          </Form><Table rows={arr(data.suppressions)} columns={["kind","value","reason","source","created_at"]}/>
        </Section>
      </div>}

      {tab === "automation" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Ingest prospect signal" subtitle="Job changes, funding, hiring, technology and product-intent events feed scoring and workflows.">
          <Form onSubmit={(e) => submit(e, "/api/platform/signals", f => ({ type:f.get("type"), title:f.get("title"), target_id:f.get("target_id")||undefined, score:Number(f.get("score")||0), source:"manual" }), "Signal ingested")}>
            <Select name="type" options={["job_change","funding","hiring","technology","product_intent","custom"]}/><Input name="title" placeholder="Signal title" required/><Input name="target_id" placeholder="Contact ID (optional)"/><Input name="score" type="number" placeholder="Intent score"/><Submit>Ingest signal</Submit>
          </Form><Table rows={arr(data.signals).slice(0,20)} columns={["type","title","score","source","occurred_at"]}/>
        </Section>
        <Section title="Signal-driven rules" subtitle="Rules can add contacts to lists and enroll them in a conditional campaign."><Table rows={arr(data.rules)} columns={["name","signal_type","min_score","list_name","workflow_name","auto_start"]}/></Section>
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
          <Section title="Create opportunity"><Form onSubmit={(e) => submit(e,"/api/platform/pipeline",f=>({name:f.get("name"),target_id:f.get("target_id")||undefined,stage_id:f.get("stage_id")||undefined,amount:Number(f.get("amount")||0),source:"manual"}),"Opportunity created")}><Input name="name" placeholder="Opportunity name" required/><Input name="target_id" placeholder="Contact ID"/><Input name="stage_id" placeholder="Stage ID"/><Input name="amount" type="number" placeholder="Amount"/><Submit>Create</Submit></Form></Section>
        </div>
        <Section title="Connections"><Connections rows={arr(data.connections)} refresh={refresh}/></Section>
        <Section title="Opportunities"><Table rows={arr(pipeline?.opportunities)} columns={["name","stage_name","contact_name","owner_email","amount","currency","source"]}/></Section>
      </div>}

      {tab === "admin" && <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Workspace members" subtitle="Invite collaborators to share outreach, assign work, manage campaigns, and review replies.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/invitations",f=>({email:f.get("email"),role:f.get("role"),send_email:true}),"Invitation created")}><Input name="email" type="email" placeholder="teammate@example.com" required/><Select name="role" options={["member","manager","viewer","admin","owner"]}/><Submit>Invite teammate</Submit></Form>
          {revealedInvite&&<div className="mb-4 rounded-[10px] border border-[var(--border)] bg-base-200 p-3"><div className="mb-1 text-xs text-base-content/55">Copy invitation link</div><button type="button" className="select-all break-all text-left text-xs text-base-content" onClick={()=>{void navigator.clipboard.writeText(revealedInvite);toast.success("Invitation link copied");}}>{revealedInvite}</button></div>}
          <Table rows={arr(workspace?.members)} columns={["email","role","created_at"]}/>
          <h3 className="mb-2 mt-5 text-[13px] font-semibold text-base-content">Invitations</h3><Invitations rows={arr((data.invitations as Data)?.invitations)} refresh={refresh}/>
        </Section>
        <Section title="Your workspaces" subtitle="Switch between outreach workspaces you own or have joined."><WorkspacePicker rows={arr(workspace?.workspaces)} active={String(workspace?.workspace?.id??"")} onSwitch={async id=>{await updateSession({workspaceId:id});window.location.reload();}}/></Section>
        <Section title="Team inbox" subtitle="Tags, saved replies, assignment, collision locks, bulk status, SLA and sentiment filters are enabled.">
          <div className="grid grid-cols-2 gap-2 mb-4"><Mini label="Members" value={arr(inbox?.members).length}/><Mini label="Tags" value={arr(inbox?.tags).length}/><Mini label="Saved replies" value={arr(inbox?.saved_replies).length}/><Mini label="Unassigned" value={inbox?.stats?.unassigned ?? 0}/></div>
          <Form onSubmit={(e)=>submit(e,"/api/platform/inbox",f=>({action:"create_saved_reply",name:f.get("name"),body:f.get("body")}),"Saved reply created")}><Input name="name" placeholder="Saved reply name"/><textarea name="body" className="textarea textarea-bordered w-full" placeholder="Reply text"/><Submit>Save reply</Submit></Form>
        </Section>
        <Section title="Public API keys" subtitle="The secret is shown once and stored only as a hash.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/api-keys",f=>({name:f.get("name"),scopes:String(f.get("scopes")||"").split(",").map(x=>x.trim()).filter(Boolean)}),"API key created")}><Input name="name" placeholder="Key name" required/><Input name="scopes" defaultValue="contacts:read,contacts:write,campaigns:read,events:read"/><Submit>Create key</Submit></Form>
          {revealedKey && <div className="mt-3 rounded-lg bg-warning/10 border border-warning/30 p-3"><div className="text-xs text-warning mb-1">Copy now — it will not be shown again</div><code className="text-xs break-all select-all">{revealedKey}</code></div>}
          <Table rows={arr(data.apiKeys)} columns={["name","key_prefix","scopes","last_used_at","created_at"]}/>
        </Section>
        <Section title="Signed webhooks" subtitle="HMAC-SHA256 deliveries retry with exponential backoff and move to a dead-letter state after eight attempts.">
          <Form onSubmit={(e)=>submit(e,"/api/platform/webhooks",f=>({url:f.get("url"),event_types:String(f.get("event_types")||"*")}),"Webhook created")}><Input name="url" type="url" placeholder="https://…" required/><Input name="event_types" defaultValue="*"/><Submit>Add endpoint</Submit></Form><Table rows={arr(data.webhooks)} columns={["url","event_types","enabled","delivery_count","dead_letters"]}/>
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
function Connections({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) { const [busy,setBusy]=useState(""); async function sync(id:string){setBusy(id);try{await api("/api/platform/connections",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({id})});toast.success("Sync complete");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setBusy("");}} return <div className="space-y-2">{rows.map((r,i)=>{const x=r as Data;return <div key={String(x.id??i)} className="flex items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium text-base-content">{String(x.name)}</div><div className="text-xs text-base-content/45">{String(x.provider)} · {x.sync_error?String(x.sync_error):x.last_synced_at?`synced ${String(x.last_synced_at)}`:"never synced"}</div></div><button className="btn btn-xs" onClick={()=>void sync(String(x.id))} disabled={busy===x.id}>{busy===x.id?"Syncing…":"Sync now"}</button></div>})}</div>; }
function Invitations({rows,refresh}:{rows:unknown[];refresh:()=>Promise<void>}) { async function revoke(id:string){try{await api(`/api/platform/invitations?id=${encodeURIComponent(id)}`,{method:"DELETE"});toast.success("Invitation revoked");await refresh();}catch(e){toast.error(e instanceof Error?e.message:String(e));}} return <div className="space-y-2">{rows.length===0&&<p className="py-2 text-xs text-base-content/40">No invitations yet.</p>}{rows.slice(0,20).map((row,i)=>{const x=row as Data;return <div key={String(x.id??i)} className="flex items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3"><div className="min-w-0 flex-1"><div className="truncate text-xs text-base-content">{String(x.email)}</div><div className="text-[11px] text-base-content/45">{String(x.role)} · {String(x.status)}</div></div>{x.status==="pending"&&<button type="button" className="btn btn-ghost btn-xs text-error" onClick={()=>void revoke(String(x.id))}>Revoke</button>}</div>})}</div>; }
function WorkspacePicker({rows,active,onSwitch}:{rows:unknown[];active:string;onSwitch:(id:string)=>Promise<void>}) { const [busy,setBusy]=useState("");return <div className="space-y-2">{rows.map((row,i)=>{const x=row as Data;const id=String(x.id??"");return <button type="button" key={id||i} disabled={id===active||busy!==""} onClick={async()=>{setBusy(id);try{await onSwitch(id);}catch(e){toast.error(e instanceof Error?e.message:String(e));setBusy("");}}} className={`flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition-colors ${id===active?"border-[var(--border-strong)] bg-base-200":"border-[var(--border-subtle)] hover:bg-base-200"}`}><div className="flex-1"><div className="text-sm font-medium text-base-content">{String(x.name)}</div><div className="text-xs text-base-content/45">{String(x.role)}</div></div><span className="text-xs text-base-content/60">{id===active?"Current":busy===id?"Switching…":"Switch"}</span></button>})}</div>; }
function arr(value:unknown):unknown[] { return Array.isArray(value)?value:[]; }
function money(value:unknown) { return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value??0)); }
function display(value:unknown) { if(value===null||value===undefined||value==="") return "—"; if(typeof value==="object") return JSON.stringify(value); return String(value); }
function parseJson(value:string) { try{return JSON.parse(value);}catch{throw new Error("Configuration must be valid JSON");} }
