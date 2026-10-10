import Head from "next/head";
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { GetServerSideProps } from "next";
import { signOut, useSession } from "next-auth/react";
import { getDb } from "@/lib/db";
import { getServerWorkspace, loginRedirect } from "@/lib/server-workspace";
import { toast } from "sonner";
import {
  RiAddLine, RiDeleteBinLine, RiEditLine,
  RiDownloadLine, RiCheckLine, RiCloseLine,
  RiLockPasswordLine, RiPlugLine,
  RiMessage2Line, RiSettings3Line, RiFileCopyLine,
  RiFlashlightLine, RiArrowDownSLine, RiCompassLine,
  RiRobot2Line,
} from "react-icons/ri";
import { ModelPicker, type OrModel } from "@/components/ui/ModelPicker";
import { ALL_TOUR_PAGES, TOUR_PAGE_LABELS, replayPageTour, type TourPage } from "@/lib/tour";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "templates" | "integrations" | "ai" | "general";

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
  // So do mailboxes.
  if (query.tab === "email") return { redirect: { destination: "/mailboxes", permanent: false } };
  const templates = db.prepare("SELECT * FROM templates WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId);
  const validTabs: Tab[] = ["templates", "integrations", "ai", "general"];
  const tab: Tab = validTabs.includes(query.tab as Tab) ? (query.tab as Tab) : "templates";
  return { props: { templates, initialTab: tab } };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "templates", label: "Templates", icon: RiMessage2Line },
  { key: "integrations", label: "Integrations", icon: RiPlugLine },
  { key: "ai", label: "AI", icon: RiRobot2Line },
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

  const [hasMcp, setHasMcp] = useState(false);
  useEffect(() => {
    fetch("/api/premium-status").then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setHasMcp(!!d.capabilities?.mcp); }).catch(() => {});
  }, []);
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
        {tab === "integrations" && <IntegrationsTab />}
        {tab === "ai" && <AiTab />}
        {tab === "general" && <GeneralTab hasMcp={hasMcp} />}
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

// ─── Integrations Tab ─────────────────────────────────────────────────────────

interface IntegrationDef {
  key: string;
  name: string;
  description: string;
  badge: string;
  badgeColor: string;
  accentColor: string;
  placeholder: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    key: "apollo",
    name: "Apollo.io",
    description: "Lead enrichment, email reveal & seniority data",
    badge: "Ap",
    badgeColor: "#2A251E",
    accentColor: "#2A251E",
    placeholder: "Apollo API key",
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    description: "Route AI requests across models (GPT-4, Claude, Llama…)",
    badge: "OR",
    badgeColor: "#2A251E",
    accentColor: "#2A251E",
    placeholder: "sk-or-...",
  },
];

interface AiConfig {
  default_model: string;
  system_prompt: string;
  user_prompt: string;
  email_examples: string;
  linkedin_examples: string;
}

const BLANK_AI_CONFIG: AiConfig = { default_model: "", system_prompt: "", user_prompt: "", email_examples: "", linkedin_examples: "" };

function AiTab() {
  const [config, setConfig] = useState<AiConfig>(BLANK_AI_CONFIG);
  const [models, setModels] = useState<OrModel[]>([]);
  const [hasKey, setHasKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/platform/ai-config").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/openrouter/models").then((r) => (r.ok ? r.json() : { models: [] })),
      fetch("/api/integrations").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([cfg, mdl, intg]) => {
        if (cfg) setConfig({
          default_model: cfg.default_model ?? "",
          system_prompt: cfg.system_prompt ?? "",
          user_prompt: cfg.user_prompt ?? "",
          email_examples: cfg.email_examples ?? "",
          linkedin_examples: cfg.linkedin_examples ?? "",
        });
        setModels(mdl?.models ?? []);
        const rows: { key: string; configured: boolean }[] = Array.isArray(intg) ? intg : (intg?.result ?? []);
        setHasKey(Boolean(rows.find((r) => r.key === "openrouter")?.configured));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    const res = await fetch("/api/platform/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default_model: config.default_model || null,
        system_prompt: config.system_prompt || null,
        user_prompt: config.user_prompt || null,
        email_examples: config.email_examples || null,
        linkedin_examples: config.linkedin_examples || null,
      }),
    });
    setSaving(false);
    if (!res.ok) { toast.error("Failed to save AI settings"); return; }
    toast.success("AI settings saved");
  }

  const set = (patch: Partial<AiConfig>) => setConfig((c) => ({ ...c, ...patch }));

  if (loading) return <div className="flex items-center gap-2 text-sm text-base-content/40 py-10"><span className="loading loading-spinner loading-xs" /> Loading…</div>;

  return (
    <div className="flex flex-col gap-4">
      {!hasKey && (
        <div className="rounded-2xl border border-warning/25 bg-warning/[0.08] px-4 py-3 text-sm text-warning">
          Add an <b>OpenRouter</b> API key in the Integrations tab to load models and enable AI features.
        </div>
      )}

      {/* Default model */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-5">
        <div className="flex items-center gap-2 mb-1">
          <RiRobot2Line size={16} className="text-base-content/50" />
          <h3 className="text-[15px] font-semibold">Default AI model</h3>
        </div>
        <p className="text-[13px] text-base-content/50 mb-4">
          Used to classify inbox replies (positive, objection, out-of-office, unsubscribe) and as the fallback model when a campaign step has AI writing on without its own model.
        </p>
        <ModelPicker
          models={models}
          value={config.default_model}
          onChange={(id) => set({ default_model: id })}
          placeholder="Select a default model…"
        />
      </div>

      {/* Prompts */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-5 flex flex-col gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">Writing style (optional)</h3>
          <p className="text-[13px] text-base-content/50 mt-1">Guide how AI writes outreach across every campaign. Leave blank to use Linki&apos;s defaults.</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-base-content">System prompt</span>
          <textarea className="textarea textarea-bordered min-h-20 text-sm" placeholder="e.g. You are a concise, friendly B2B SDR. Never use hype or exclamation marks." value={config.system_prompt} onChange={(e) => set({ system_prompt: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-base-content">User prompt</span>
          <textarea className="textarea textarea-bordered min-h-20 text-sm" placeholder="Extra instructions appended to every generation." value={config.user_prompt} onChange={(e) => set({ user_prompt: e.target.value })} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-base-content">Email examples</span>
            <textarea className="textarea textarea-bordered min-h-24 text-sm" placeholder="Paste 1–3 great emails as few-shot examples." value={config.email_examples} onChange={(e) => set({ email_examples: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-base-content">LinkedIn examples</span>
            <textarea className="textarea textarea-bordered min-h-24 text-sm" placeholder="Paste 1–3 great LinkedIn messages." value={config.linkedin_examples} onChange={(e) => set({ linkedin_examples: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 h-10 px-5 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50">
          {saving ? <span className="loading loading-spinner loading-xs" /> : null}
          Save AI settings
        </button>
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const [configuredMap, setConfiguredMap] = useState<Record<string, { masked: string | null; configured: boolean }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((rows: { key: string; api_key_masked: string | null; configured: boolean }[]) => {
        const m: Record<string, { masked: string | null; configured: boolean }> = {};
        for (const row of rows) m[row.key] = { masked: row.api_key_masked, configured: row.configured };
        setConfiguredMap(m);
      })
      .catch(() => {});
  }, []);

  async function save(key: string, e: React.FormEvent) {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    setSaving(true);
    const res = await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, api_key: apiKeyInput.trim() }),
    });
    setSaving(false);
    if (!res.ok) { toast.error("Failed to save"); return; }
    const masked = "••••••••" + apiKeyInput.trim().slice(-4);
    setConfiguredMap((m) => ({ ...m, [key]: { masked, configured: true } }));
    setEditingKey(null);
    setApiKeyInput("");
    toast.success("API key saved");
  }

  async function remove(key: string) {
    await fetch(`/api/integrations?key=${key}`, { method: "DELETE" });
    setConfiguredMap((m) => ({ ...m, [key]: { masked: null, configured: false } }));
    toast.success("Integration removed");
  }

  return (
    <div className="flex flex-col gap-3">
      {INTEGRATIONS.map((intg) => {
        const state = configuredMap[intg.key];
        const configured = state?.configured ?? false;
        const isEditing = editingKey === intg.key;

        return (
          <div key={intg.key} className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] overflow-hidden">
            <div className="flex items-center gap-4 px-4 py-3.5">
              {/* Logo badge */}
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ background: intg.badgeColor + "22", color: intg.badgeColor, border: `1px solid ${intg.badgeColor}33` }}
              >
                {intg.badge}
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{intg.name}</p>
                  {configured && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-success/15 text-success">
                      <RiCheckLine size={9} /> Connected
                    </span>
                  )}
                </div>
                <p className="text-xs text-base-content/40">{intg.description}</p>
              </div>
              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {configured && !isEditing && (
                  <>
                    <span className="text-xs text-base-content/25 font-mono">{state?.masked}</span>
                    <button onClick={() => { setEditingKey(intg.key); setApiKeyInput(""); }} className="text-xs text-base-content/40 hover:text-base-content/70 transition-colors px-2 py-1">Change</button>
                    <button onClick={() => remove(intg.key)} className="text-xs text-error/50 hover:text-error transition-colors p-1"><RiCloseLine size={14} /></button>
                  </>
                )}
                {!configured && !isEditing && (
                  <button
                    onClick={() => { setEditingKey(intg.key); setApiKeyInput(""); }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 transition-colors"
                  >
                    Configure
                  </button>
                )}
                {isEditing && (
                  <button onClick={() => { setEditingKey(null); setApiKeyInput(""); }} className="text-xs text-base-content/40 hover:text-base-content/70 transition-colors px-1 py-1">
                    <RiCloseLine size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Inline key input */}
            {isEditing && (
              <form onSubmit={(e) => save(intg.key, e)} className="px-4 pb-4 flex gap-2">
                <input
                  type="text"
                  autoFocus
                  className="input input-bordered input-sm flex-1 font-mono text-xs"
                  placeholder={intg.placeholder}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  required
                />
                <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50">
                  {saving ? <span className="loading loading-spinner loading-xs" /> : "Save"}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── General Tab ──────────────────────────────────────────────────────────────

// ─── MCP card ─────────────────────────────────────────────────────────────────
// Lets the user grab the hosted MCP URL for this Linki instance (self-hosted, so
// it's built from the browser's own origin) and copy the one-liner to connect an
// AI agent. Hidden unless this build exposes the hosted MCP capability.

function McpCard() {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mcpUrl, setMcpUrl] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setMcpUrl(`${window.location.origin}/api/mcp`);
    }
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — user can still select the text */
    }
  }

  if (!mcpUrl) return null;

  const cliCommand = `claude mcp add --transport http linki ${mcpUrl}`;

  return (
    <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <RiFlashlightLine size={13} className="text-primary shrink-0" />
        <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">MCP — connect an AI agent</p>
        <RiArrowDownSLine size={15} className={`ml-auto text-base-content/30 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          <p className="text-xs text-base-content/50 mb-3 leading-relaxed">
            Connect Claude Code, Claude.ai, Cursor, or any MCP-compatible AI agent to this Linki instance —
            it can read contacts, launch campaigns, and review replies on your behalf.
          </p>

          <div className="rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wide text-base-content/40 mb-2">
              MCP server URL
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md bg-base-100 border border-[var(--border-subtle)] px-3 py-2 text-xs text-base-content font-mono">
                {mcpUrl}
              </code>
              <button
                onClick={() => copy(mcpUrl)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-base-content/70 hover:bg-base-200 transition-colors"
              >
                {copied ? <RiCheckLine size={13} className="text-success" /> : <RiFileCopyLine size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="mt-3 text-xs text-base-content/50 leading-relaxed">
            <p className="mb-1.5"><span className="text-base-content/70 font-medium">Claude Code</span> — run this in your terminal:</p>
            <div className="flex items-center gap-2 mb-1.5">
              <code className="flex-1 min-w-0 truncate rounded-md bg-base-200 border border-[var(--border-subtle)] px-3 py-2 text-xs text-base-content font-mono">
                {cliCommand}
              </code>
              <button
                onClick={() => copy(cliCommand)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-base-content/70 hover:bg-base-200 transition-colors"
              >
                <RiFileCopyLine size={13} />
              </button>
            </div>
            <p>
              Other agents (Cursor, Claude desktop/web, etc.) — add it as an HTTP MCP server / connector
              using the URL above. You&apos;ll be prompted to sign in to Linki in the browser on first use.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function GeneralTab({ hasMcp }: { hasMcp: boolean }) {
  const router = useRouter();
  const { data: session } = useSession();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [loading, setLoading] = useState(false);
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

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) { toast.error("Passwords don't match"); return; }
    setLoading(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
    });
    setLoading(false);
    if (!res.ok) { toast.error((await res.json()).error ?? "Failed"); return; }
    // Changing the password signs every device out, this one included.
    await signOut({ callbackUrl: "/login?notice=password-changed" });
  }

  return (
    <div className="max-w-sm flex flex-col gap-4">
      {/* Account */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide mb-2">Account</p>
        <p className="text-sm text-base-content/70">
          Signed in as <span className="text-base-content font-medium">{session?.user?.email ?? "—"}</span>
        </p>
      </div>

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

      {hasMcp && <McpCard />}

      {/* Product tour */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <RiCompassLine size={13} className="text-base-content/40" />
          <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Product tour</p>
        </div>
        <p className="text-xs text-base-content/50 mb-3">
          Replay the guided walkthrough for any page.
        </p>
        <select
          className="w-full px-3 py-1.5 rounded-[10px] text-sm bg-base-100 border border-[var(--border)] text-base-content focus:outline-none focus:border-[var(--border-focus)] cursor-pointer"
          defaultValue=""
          onChange={(e) => {
            const page = e.target.value as TourPage;
            if (!page) return;
            e.target.value = "";
            if (page === "settings") {
              replayPageTour(page);
            } else {
              router.push(page === "dashboard" ? "/" : `/${page}`).then(() => setTimeout(() => replayPageTour(page), 400));
            }
          }}
        >
          <option value="">Select a page to replay…</option>
          {ALL_TOUR_PAGES.map((p) => (
            <option key={p} value={p}>{TOUR_PAGE_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {/* Change password */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <RiLockPasswordLine size={13} className="text-base-content/40" />
          <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Change password</p>
        </div>
        <form onSubmit={handleChangePassword} className="flex flex-col gap-3">
          <div>
            <label className="label text-xs text-base-content/50 pb-1">Current password</label>
            <input type="password" className="input input-bordered input-sm w-full" placeholder="Current password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} required />
          </div>
          <div>
            <label className="label text-xs text-base-content/50 pb-1">New password</label>
            <input type="password" className="input input-bordered input-sm w-full" placeholder="Min. 8 characters" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} minLength={8} required />
          </div>
          <div>
            <label className="label text-xs text-base-content/50 pb-1">Confirm new password</label>
            <input type="password" className="input input-bordered input-sm w-full" placeholder="Repeat new password" value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} required />
          </div>
          <p className="text-[11px] text-base-content/40">Changing your password signs you out on every device, including this one.</p>
          <div className="flex justify-end pt-1">
            <button type="submit" disabled={loading} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50">
              {loading ? <span className="loading loading-spinner loading-xs" /> : "Update password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
