import Head from "next/head";
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { GetServerSideProps } from "next";
import { getDb } from "@/lib/db";
import { getServerWorkspace, loginRedirect } from "@/lib/server-workspace";
import { toast } from "sonner";
import {
  RiAddLine, RiDeleteBinLine, RiDownloadLine, RiEditLine, RiMessage2Line, RiSettings3Line,
} from "react-icons/ri";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "templates" | "general";

interface Template {
  id: number; name: string; body: string; created_at: string;
}

// ─── Server-side data ─────────────────────────────────────────────────────────

export const getServerSideProps: GetServerSideProps = async ({ query, req, res }) => {
  const db = getDb();
  const workspace = await getServerWorkspace(req, res);
  if (!workspace) return loginRedirect(req);
  const { workspaceId } = workspace;
  // LinkedIn accounts have their own page now; old links to the tab that held them follow it there.
  if (query.tab === "linkedin") return { redirect: { destination: "/linkedin-accounts", permanent: false } };
  // So do AI settings.
  if (query.tab === "ai") return { redirect: { destination: "/ai", permanent: false } };
  // So do mailboxes.
  if (query.tab === "email") return { redirect: { destination: "/mailboxes", permanent: false } };
  // And provider keys, with the CRM and calendar connections that used to be on another page.
  if (query.tab === "integrations") return { redirect: { destination: "/integrations", permanent: false } };
  const templates = db.prepare("SELECT * FROM templates WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId);
  const validTabs: Tab[] = ["templates", "general"];
  const tab: Tab = validTabs.includes(query.tab as Tab) ? (query.tab as Tab) : "templates";
  return { props: { templates, initialTab: tab } };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "templates", label: "Templates", icon: RiMessage2Line },
  { key: "general", label: "General", icon: RiSettings3Line },
];

// Standard merge tags supported by the render engine (lib/outreach/render.ts).
const STANDARD_VARS = ["first_name", "last_name", "full_name", "company", "title", "location"];
type VarChip = { token: string; label: string; custom: boolean };
function buildVarChips(customFields: { key: string }[]): VarChip[] {
  const std: VarChip[] = STANDARD_VARS.map((k) => ({ token: `{{${k}}}`, label: k, custom: false }));
  const custom: VarChip[] = customFields
    .filter((f) => f.key && !STANDARD_VARS.includes(f.key))
    .map((f) => ({ token: `{{${f.key}}}`, label: f.key, custom: true }));
  return [...std, ...custom];
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage({
  templates: initialTemplates,
  initialTab,
}: {
  templates: Template[];
  initialTab: Tab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  const visibleTabs = TABS;

  function switchTab(t: Tab) {
    setTab(t);
    router.replace(`/settings?tab=${t}`, undefined, { shallow: true });
  }

  return (
    <>
      <Head>
        <title>Settings — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="max-w-3xl">
        {/* Page header */}
        <div className="mb-6">
          <p className="mb-2 text-[13px] font-medium text-base-content/45">Workspace</p>
          <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Settings</h1>
          <p className="mt-2 text-[15px] text-base-content/50">Accounts, integrations, and preferences.</p>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)]">
          {visibleTabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              data-tour={`settings-tab-${key}`}
              onClick={() => switchTab(key)}
              className={`relative -mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === key
                  ? "border-primary text-base-content"
                  : "border-transparent text-base-content/40 hover:text-base-content/70"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === "templates" && <TemplatesTab initialTemplates={initialTemplates} />}
        {tab === "general" && <GeneralTab />}
      </div>
    </>
  );
}

// ─── Templates Tab ────────────────────────────────────────────────────────────

function TemplatesTab({ initialTemplates }: { initialTemplates: Template[] }) {
  const [templates, setTemplates] = useState<Template[]>(initialTemplates);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState({ name: "", body: "" });
  const [loading, setLoading] = useState(false);
  const [customFields, setCustomFields] = useState<{ key: string }[]>([]);
  useEffect(() => {
    fetch("/api/platform/custom-fields")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d)) setCustomFields(d); })
      .catch(() => {});
  }, []);
  const variableChips = buildVarChips(customFields);

  async function refresh() {
    const res = await fetch("/api/templates");
    setTemplates(await res.json());
  }

  function openCreate() { setEditing(null); setForm({ name: "", body: "" }); setShowModal(true); }
  function openEdit(t: Template) { setEditing(t); setForm({ name: t.name, body: t.body }); setShowModal(true); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const url = editing ? `/api/templates/${editing.id}` : "/api/templates";
    const res = await fetch(url, {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setLoading(false);
    if (!res.ok) { toast.error("Failed to save"); return; }
    toast.success(editing ? "Updated" : "Created");
    setShowModal(false);
    refresh();
  }

  async function del(id: number) {
    if (!confirm("Delete this template?")) return;
    await fetch(`/api/templates/${id}`, { method: "DELETE" });
    toast.success("Deleted");
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-base-content/50">
          Use <code className="text-primary text-xs">{"{{first_name}}"}</code>, <code className="text-primary text-xs">{"{{company}}"}</code> as variables
        </p>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors" onClick={openCreate}>
          <RiAddLine size={14} /> New Template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="text-center py-12 text-base-content/30 text-sm border border-dashed border-[var(--border)] rounded-2xl">No templates yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {templates.map((t) => (
            <div key={t.id} className="flex items-start gap-4 px-4 py-3 bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] hover:border-[var(--border)] transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{t.name}</p>
                <p className="text-xs text-base-content/40 mt-0.5 line-clamp-2 whitespace-pre-wrap">{t.body}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button className="inline-flex items-center p-1.5 rounded-lg text-base-content/40 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => openEdit(t)}>
                  <RiEditLine size={14} />
                </button>
                <button className="inline-flex items-center p-1.5 rounded-lg bg-error/10 text-error border border-error/20 hover:bg-error/20 transition-colors" onClick={() => del(t.id)}>
                  <RiDeleteBinLine size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="modal modal-open">
          <div className="modal-box bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] max-w-lg">
            <h3 className="font-semibold text-base mb-4">{editing ? "Edit Template" : "New Template"}</h3>
            <form onSubmit={save} className="flex flex-col gap-3">
              <div>
                <label className="label text-xs text-base-content/50 pb-1">Template name</label>
                <input className="input input-bordered input-sm w-full" placeholder="e.g. Connection note" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div>
                <label className="label text-xs text-base-content/50 pb-1">Body</label>
                <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                  <span className="text-xs text-base-content/40">Insert:</span>
                  {variableChips.map((c) => (
                    <button key={c.token} type="button" title={c.custom ? "Custom field" : undefined}
                      onClick={() => {
                        const el = document.getElementById("tmpl-body") as HTMLTextAreaElement | null;
                        const pos = el?.selectionStart ?? form.body.length;
                        setForm((f) => ({ ...f, body: f.body.slice(0, pos) + c.token + f.body.slice(pos) }));
                        setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + c.token.length, pos + c.token.length); }, 0);
                      }}
                      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-base-200 text-base-content/70 hover:bg-base-300 transition-colors font-mono">
                      {c.label}{c.custom && <span className="w-1 h-1 rounded-full bg-base-content/40" />}
                    </button>
                  ))}
                </div>
                <textarea id="tmpl-body" className="textarea textarea-bordered w-full text-sm font-mono" rows={6} placeholder="Hi {{first_name}}, I noticed you're at {{company}}..." value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
              </div>
              <div className="modal-action mt-1">
                <button type="button" className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50" disabled={loading}>
                  {loading ? <span className="loading loading-spinner loading-xs" /> : "Save"}
                </button>
              </div>
            </form>
          </div>
          <div className="modal-backdrop" onClick={() => setShowModal(false)} />
        </div>
      )}
    </div>
  );
}

// ─── General Tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const [importCap, setImportCap] = useState<number | "">("");
  const [capSaving, setCapSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings/import-cap").then((r) => r.json()).then((d) => setImportCap(d.cap ?? 1500)).catch(() => {});
  }, []);

  async function saveImportCap(e: React.FormEvent) {
    e.preventDefault();
    setCapSaving(true);
    const res = await fetch("/api/settings/import-cap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cap: Number(importCap) }),
    });
    setCapSaving(false);
    if (!res.ok) { toast.error((await res.json()).error ?? "Failed"); return; }
    toast.success("Daily import limit saved");
  }

  return (
    <div className="max-w-sm flex flex-col gap-4">
      {/* Daily import limit */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <div className="flex items-center gap-2 mb-1">
          <RiDownloadLine size={13} className="text-base-content/40" />
          <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Daily import limit</p>
        </div>
        <p className="text-xs text-base-content/50 mb-3">
          Max contacts imported from Sales Navigator per day (across all lists). Larger lists are split into batches over consecutive days to stay under LinkedIn&apos;s radar.
        </p>
        <form onSubmit={saveImportCap} className="flex items-end gap-2">
          <div className="flex-1">
            <input type="number" min={1} className="input input-bordered input-sm w-full" placeholder="1500" value={importCap} onChange={(e) => setImportCap(e.target.value === "" ? "" : Number(e.target.value))} required />
          </div>
          <button type="submit" disabled={capSaving} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50">
            {capSaving ? <span className="loading loading-spinner loading-xs" /> : "Save"}
          </button>
        </form>
      </div>

      {/* How to connect an AI client over MCP is on /developers. */}
    </div>
  );
}
