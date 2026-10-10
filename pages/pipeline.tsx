import Head from "next/head";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { RiAddLine, RiArrowDownSLine, RiArrowUpSLine } from "react-icons/ri";
import RecordPicker, { searchCompanies, searchContacts, type PickedRecord } from "@/components/ui/RecordPicker";

interface Stage { id: string; name: string; position: number; probability: number; is_won: number; is_lost: number }
interface Opportunity {
  id: string; name: string; stage_id: string | null; owner_id: string | null; target_id: string | null; company_id: string | null;
  amount: number | null; currency: string; expected_close_date: string | null; closed_at: string | null;
  contact_name: string | null; company_name: string | null; owner_email: string | null;
}
interface Member { id: string; email: string }
interface Board { stages: Stage[]; opportunities: Opportunity[]; members: Member[] }

// Opportunities whose stage was deleted out from under them, or that were never given one.
const NO_STAGE = "";

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}
const send = (method: string, body: unknown) => api("/api/platform/pipeline", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount); }
  catch { return `${currency} ${Math.round(amount).toLocaleString()}`; }
}

/** Amounts in different currencies are never added together; each is totalled on its own. */
function totals(rows: Opportunity[], weight: (row: Opportunity) => number = () => 1): string {
  const byCurrency = new Map<string, number>();
  for (const row of rows) if (row.amount) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amount * weight(row));
  return [...byCurrency].map(([currency, amount]) => money(amount, currency)).join(" · ") || "—";
}

const day = (date: Date) => date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
/** Stored timestamps are UTC without a zone ("2026-10-03 14:00:00"). */
const stored = (text: string) => new Date(`${text.replace(" ", "T")}Z`);

export default function PipelinePage() {
  const { data: session } = useSession();
  const role = session?.user?.role ?? "viewer";
  const canEdit = role !== "viewer";
  const canManageStages = ["owner", "admin", "manager"].includes(role);

  const [board, setBoard] = useState<Board>({ stages: [], opportunities: [], members: [] });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Opportunity | { stage_id: string | null } | null>(null);
  const [editingStages, setEditingStages] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/platform/pipeline");
      setBoard({ stages: data.stages ?? [], opportunities: data.opportunities ?? [], members: data.members ?? [] });
    } catch (error) { toast.error(message(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const stageById = useMemo(() => new Map(board.stages.map((stage) => [stage.id, stage])), [board.stages]);
  const columns = useMemo(() => {
    const inStage = new Map<string, Opportunity[]>();
    for (const row of board.opportunities) {
      const key = row.stage_id && stageById.has(row.stage_id) ? row.stage_id : NO_STAGE;
      inStage.set(key, [...(inStage.get(key) ?? []), row]);
    }
    const unplaced = inStage.get(NO_STAGE);
    return [
      ...(unplaced ? [{ id: NO_STAGE, name: "No stage", stage: null as Stage | null, rows: unplaced }] : []),
      ...board.stages.map((stage) => ({ id: stage.id, name: stage.name, stage: stage as Stage | null, rows: inStage.get(stage.id) ?? [] })),
    ];
  }, [board, stageById]);

  const summary = useMemo(() => {
    const stageOf = (row: Opportunity) => (row.stage_id ? stageById.get(row.stage_id) : undefined);
    const open = board.opportunities.filter((row) => { const stage = stageOf(row); return !stage?.is_won && !stage?.is_lost; });
    return [
      ["Open", totals(open)],
      ["Weighted", totals(open, (row) => (stageOf(row)?.probability ?? 0) / 100)],
      ["Won", totals(board.opportunities.filter((row) => stageOf(row)?.is_won))],
    ];
  }, [board.opportunities, stageById]);

  async function move(opportunity: Opportunity, stageId: string) {
    if ((opportunity.stage_id ?? NO_STAGE) === stageId || stageId === NO_STAGE) return;
    const replace = (next: Opportunity) => setBoard((current) => ({ ...current, opportunities: current.opportunities.map((row) => (row.id === next.id ? next : row)) }));
    // Shown in its new column at once; put back if the move is refused.
    replace({ ...opportunity, stage_id: stageId });
    try { replace(await send("PATCH", { id: opportunity.id, stage_id: stageId })); }
    catch (error) { replace(opportunity); toast.error(message(error)); }
  }

  return (
    <>
      <Head><title>Pipeline — Linki</title><meta name="robots" content="noindex, nofollow" /></Head>
      <div className="space-y-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Deals</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Pipeline</h1>
            <p className="mt-2 text-[15px] text-base-content/50">Opportunities by stage. Drag a card to move it, or use its “Move to” menu.</p>
          </div>
          <div className="flex items-center gap-2">
            {canManageStages && <button type="button" onClick={() => setEditingStages(true)} className="inline-flex h-10 items-center rounded-[10px] border border-[var(--border)] bg-base-100 px-4 text-sm font-medium text-base-content/70 transition-colors hover:bg-base-200">Edit stages</button>}
            {canEdit && <button type="button" disabled={board.stages.length === 0} onClick={() => setEditing({ stage_id: board.stages[0]?.id ?? null })} className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-sm font-semibold text-primary-content transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"><RiAddLine size={16} /> New opportunity</button>}
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          {summary.map(([label, value]) => (
            <div key={label}><dt className="text-[13px] text-base-content/45">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums text-base-content">{value}</dd></div>
          ))}
        </dl>

        {loading ? <p className="text-sm text-base-content/40">Loading…</p>
          : board.stages.length === 0 ? <p className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-6 text-sm text-base-content/55">This pipeline has no stages yet. {canManageStages ? "Add some under “Edit stages”." : "A manager can add them."}</p>
          : (
            <div className="flex gap-3 overflow-x-auto pb-3">
              {columns.map((column) => (
                <section
                  key={column.id} aria-label={column.name}
                  onDragOver={(e) => { if (dragging && column.id !== NO_STAGE) { e.preventDefault(); setOver(column.id); } }}
                  onDragLeave={() => setOver((current) => (current === column.id ? null : current))}
                  onDrop={(e) => { e.preventDefault(); setOver(null); const row = board.opportunities.find((x) => x.id === dragging); if (row) void move(row, column.id); }}
                  className={`flex w-[272px] shrink-0 flex-col rounded-2xl border p-2 transition-colors ${over === column.id ? "border-[var(--border-focus)] bg-base-200" : "border-[var(--border-subtle)] bg-base-200/50"}`}
                >
                  <header className="px-2 pb-2 pt-1.5">
                    <div className="flex items-baseline gap-2">
                      <h2 className="truncate text-[13px] font-semibold text-base-content">{column.name}</h2>
                      <span className="text-[12px] tabular-nums text-base-content/40">{column.rows.length}</span>
                      {column.stage && <span className={`ml-auto shrink-0 text-[11px] ${column.stage.is_won ? "text-success" : column.stage.is_lost ? "text-error" : "text-base-content/35"}`}>{column.stage.is_won ? "won" : column.stage.is_lost ? "lost" : `${column.stage.probability}%`}</span>}
                    </div>
                    <div className="mt-0.5 text-[12px] tabular-nums text-base-content/45">{totals(column.rows)}</div>
                  </header>
                  <div className="flex min-h-16 flex-col gap-2">
                    {column.rows.map((row) => (
                      <Card
                        key={row.id} row={row} stage={column.stage} stages={board.stages} canEdit={canEdit} dimmed={dragging === row.id}
                        onOpen={() => setEditing(row)} onMove={(stageId) => void move(row, stageId)}
                        onDragStart={() => setDragging(row.id)} onDragEnd={() => { setDragging(null); setOver(null); }}
                      />
                    ))}
                    {column.rows.length === 0 && <p className="px-2 py-3 text-[12px] text-base-content/30">Nothing here</p>}
                  </div>
                </section>
              ))}
            </div>
          )}
      </div>

      {editing && <OpportunityModal opportunity={editing} board={board} canEdit={canEdit} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {editingStages && <StagesModal board={board} onClose={() => setEditingStages(false)} reload={load} />}
    </>
  );
}

interface CardProps {
  row: Opportunity; stage: Stage | null; stages: Stage[]; canEdit: boolean; dimmed: boolean;
  onOpen: () => void; onMove: (stageId: string) => void; onDragStart: () => void; onDragEnd: () => void;
}

function Card({ row, stage, stages, canEdit, dimmed, onOpen, onMove, onDragStart, onDragEnd }: CardProps) {
  const closed = Boolean(stage?.is_won || stage?.is_lost);
  const due = row.expected_close_date ? new Date(`${row.expected_close_date}T00:00:00`) : null;
  const late = Boolean(due && !closed && due.getTime() < new Date().setHours(0, 0, 0, 0));
  const who = [row.company_name, row.contact_name].filter(Boolean).join(" · ");
  return (
    <article
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", row.id); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      className={`rounded-[10px] border border-[var(--border-subtle)] bg-base-100 p-3 shadow-[var(--shadow-flat)] ${canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${dimmed ? "opacity-40" : ""}`}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="text-[13px] font-medium leading-snug text-base-content">{row.name}</div>
        {who && <div className="mt-0.5 truncate text-[12px] text-base-content/50">{who}</div>}
      </button>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-medium tabular-nums text-base-content/80">{row.amount == null ? "No amount" : money(row.amount, row.currency)}</span>
        {closed && row.closed_at ? <span className="text-base-content/40">Closed {day(stored(row.closed_at))}</span>
          : due ? <span className={late ? "text-warning" : "text-base-content/40"}>{late ? "Was due" : "Closes"} {day(due)}</span> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-base-content/40">{row.owner_email ? row.owner_email.split("@")[0] : "No owner"}</span>
        {canEdit && (
          <select
            aria-label={`Move ${row.name} to another stage`} value="" onChange={(e) => onMove(e.target.value)}
            className="h-6 max-w-[112px] shrink-0 cursor-pointer rounded-md border border-[var(--border-subtle)] bg-base-100 px-1 text-[11px] text-base-content/55 focus:border-[var(--border-focus)] focus:outline-none"
          >
            <option value="" disabled>Move to…</option>
            {stages.filter((option) => option.id !== row.stage_id).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        )}
      </div>
    </article>
  );
}

const field = "h-10 w-full rounded-[10px] border border-[var(--border)] bg-base-100 px-3 text-sm text-base-content placeholder:text-base-content/35 focus:border-[var(--border-focus)] focus:outline-none disabled:opacity-60";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs text-base-content/50">{label}</span>{children}</label>;
}

interface OpportunityModalProps { opportunity: Opportunity | { stage_id: string | null }; board: Board; canEdit: boolean; onClose: () => void; onSaved: () => void }

function OpportunityModal({ opportunity, board, canEdit, onClose, onSaved }: OpportunityModalProps) {
  const existing = "id" in opportunity ? opportunity : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [amount, setAmount] = useState(existing?.amount == null ? "" : String(existing.amount));
  const [currency, setCurrency] = useState(existing?.currency ?? "USD");
  const [closeDate, setCloseDate] = useState(existing?.expected_close_date ?? "");
  const [stageId, setStageId] = useState(opportunity.stage_id ?? "");
  const [ownerId, setOwnerId] = useState(existing?.owner_id ?? "");
  const [contact, setContact] = useState<PickedRecord | null>(existing?.target_id ? { id: existing.target_id, label: existing.contact_name ?? "Contact" } : null);
  const [company, setCompany] = useState<PickedRecord | null>(existing?.company_id ? { id: existing.company_id, label: existing.company_name ?? "Company" } : null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    // A new opportunity with no owner chosen is left to the route, which gives it to whoever made it.
    const body = {
      name, amount: amount === "" ? null : Number(amount), currency, expected_close_date: closeDate || null,
      stage_id: stageId || null, target_id: contact?.id ?? null, company_id: company?.id ?? null,
      ...(existing || ownerId ? { owner_id: ownerId || null } : {}),
    };
    try {
      await send(existing ? "PATCH" : "POST", existing ? { id: existing.id, ...body } : { ...body, source: "manual" });
      toast.success(existing ? "Opportunity saved" : "Opportunity added");
      onSaved();
    } catch (error) { toast.error(message(error)); setBusy(false); }
  }

  async function remove() {
    if (!existing || !confirm(`Delete “${existing.name}”? This cannot be undone.`)) return;
    setBusy(true);
    try { await api(`/api/platform/pipeline?id=${encodeURIComponent(existing.id)}`, { method: "DELETE" }); toast.success("Opportunity deleted"); onSaved(); }
    catch (error) { toast.error(message(error)); setBusy(false); }
  }

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-lg overflow-visible rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-modal)]">
        <h3 className="mb-4 text-base font-semibold">{existing ? "Opportunity" : "New opportunity"}</h3>
        <form onSubmit={save} className="flex flex-col gap-3">
          <fieldset disabled={!canEdit || busy} className="flex flex-col gap-3">
            <Field label="Name"><input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme — annual plan" required autoFocus={!existing} /></Field>
            <div className="grid grid-cols-[1fr_88px_1fr] gap-3">
              <Field label="Amount"><input className={field} type="number" min="0" step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></Field>
              <Field label="Currency"><input className={`${field} uppercase`} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} pattern="[A-Za-z]{3}" required /></Field>
              <Field label="Expected close"><input className={field} type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stage">
                <select className={field} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  {!stageId && <option value="">No stage</option>}
                  {board.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
              </Field>
              <Field label="Owner">
                <select className={field} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">{existing ? "No owner" : "Me"}</option>
                  {board.members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}
                </select>
              </Field>
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <div><span className="mb-1 block text-xs text-base-content/50">Contact</span>{canEdit ? <RecordPicker label="Contact" placeholder="Search people…" value={contact} onChange={setContact} search={searchContacts} /> : <p className="text-sm text-base-content/70">{contact?.label ?? "—"}</p>}</div>
            <div><span className="mb-1 block text-xs text-base-content/50">Company</span>{canEdit ? <RecordPicker label="Company" placeholder="Search companies…" value={company} onChange={setCompany} search={searchCompanies} /> : <p className="text-sm text-base-content/70">{company?.label ?? "—"}</p>}</div>
          </div>
          {existing?.closed_at && <p className="text-xs text-base-content/45">Closed {day(stored(existing.closed_at))}</p>}
          <div className="modal-action mt-2 items-center">
            {existing && canEdit && <button type="button" disabled={busy} onClick={() => void remove()} className="btn btn-ghost btn-sm mr-auto text-error">Delete</button>}
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">{canEdit ? "Cancel" : "Close"}</button>
            {canEdit && <button type="submit" disabled={busy} className="btn btn-primary btn-sm">{existing ? "Save" : "Add opportunity"}</button>}
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

type StageKind = "open" | "won" | "lost";
interface StageDraft { id: string; name: string; probability: string; kind: StageKind }
const kindOf = (stage: Stage): StageKind => (stage.is_won ? "won" : stage.is_lost ? "lost" : "open");
const draftOf = (stage: Stage): StageDraft => ({ id: stage.id, name: stage.name, probability: String(stage.probability), kind: kindOf(stage) });

function StagesModal({ board, onClose, reload }: { board: Board; onClose: () => void; reload: () => Promise<void> }) {
  const [drafts, setDrafts] = useState<StageDraft[]>(() => board.stages.map(draftOf));
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  // The stage being deleted while it still holds opportunities, and where they are to go.
  const [emptying, setEmptying] = useState<{ id: string; moveTo: string } | null>(null);
  const count = (id: string) => board.opportunities.filter((row) => row.stage_id === id).length;
  const patch = (id: string, change: Partial<StageDraft>) => setDrafts((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  const shift = (index: number, by: number) => setDrafts((rows) => { const next = [...rows]; const [moved] = next.splice(index, 1); next.splice(index + by, 0, moved); return next; });

  /** Run one change, then show the pipeline as the server now has it. */
  async function run(work: () => Promise<unknown>, done: string, after?: (stages: Stage[]) => void) {
    setBusy(true);
    try {
      await work();
      const data = await api("/api/platform/pipeline");
      after?.(data.stages ?? []);
      await reload();
      toast.success(done);
    } catch (error) { toast.error(message(error)); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      for (const draft of drafts) {
        const stage = board.stages.find((row) => row.id === draft.id);
        if (!stage) continue;
        // A won stage is certain and a lost one is nothing, so their chance is not asked for.
        const probability = draft.kind === "won" ? 100 : draft.kind === "lost" ? 0 : Number(draft.probability);
        if (draft.name.trim() === stage.name && probability === stage.probability && draft.kind === kindOf(stage)) continue;
        await send("PATCH", { entity: "stage", id: draft.id, name: draft.name, probability, is_won: draft.kind === "won", is_lost: draft.kind === "lost" });
      }
      if (drafts.some((draft, index) => board.stages[index]?.id !== draft.id)) await send("PATCH", { entity: "stage_order", ids: drafts.map((draft) => draft.id) });
    }, "Stages saved", (stages) => setDrafts(stages.map(draftOf)));
  }

  const add = () => run(() => send("POST", { entity: "stage", name: newName, probability: 0 }), "Stage added", (stages) => {
    // Keep whatever is half-edited in the other rows; only the new stage is appended.
    setDrafts((rows) => [...rows, ...stages.filter((stage) => !rows.some((row) => row.id === stage.id)).map(draftOf)]);
    setNewName("");
  });

  const remove = (id: string, moveTo?: string) => run(
    () => api(`/api/platform/pipeline?stage_id=${encodeURIComponent(id)}${moveTo ? `&move_to=${encodeURIComponent(moveTo)}` : ""}`, { method: "DELETE" }),
    "Stage deleted", () => { setDrafts((rows) => rows.filter((row) => row.id !== id)); setEmptying(null); },
  );

  function askRemove(draft: StageDraft) {
    const held = count(draft.id);
    if (held > 0) { setEmptying({ id: draft.id, moveTo: drafts.find((row) => row.id !== draft.id)?.id ?? "" }); return; }
    if (confirm(`Delete the “${draft.name}” stage?`)) void remove(draft.id);
  }

  const small = "h-9 rounded-[10px] border border-[var(--border)] bg-base-100 px-2.5 text-sm text-base-content focus:border-[var(--border-focus)] focus:outline-none disabled:opacity-50";
  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-xl rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-modal)]">
        <h3 className="text-base font-semibold">Pipeline stages</h3>
        <p className="mb-4 mt-0.5 text-xs text-base-content/45">The columns of the board, left to right. The chance of winning weights the open total.</p>
        <form onSubmit={save} className="flex flex-col gap-2">
          {drafts.map((draft, index) => (
            <div key={draft.id}>
              <div className="flex items-center gap-2">
                <div className="flex flex-col">
                  <button type="button" aria-label={`Move ${draft.name} earlier`} disabled={busy || index === 0} onClick={() => shift(index, -1)} className="text-base-content/40 hover:text-base-content disabled:opacity-25"><RiArrowUpSLine size={16} /></button>
                  <button type="button" aria-label={`Move ${draft.name} later`} disabled={busy || index === drafts.length - 1} onClick={() => shift(index, 1)} className="text-base-content/40 hover:text-base-content disabled:opacity-25"><RiArrowDownSLine size={16} /></button>
                </div>
                <input aria-label="Stage name" className={`${small} min-w-0 flex-1`} value={draft.name} onChange={(e) => patch(draft.id, { name: e.target.value })} required disabled={busy} />
                <select aria-label={`${draft.name} is`} className={`${small} w-24`} value={draft.kind} onChange={(e) => patch(draft.id, { kind: e.target.value as StageKind })} disabled={busy}>
                  <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
                </select>
                <div className="relative w-20">
                  <input aria-label={`Chance of winning from ${draft.name}, percent`} className={`${small} w-full pr-6 tabular-nums`} type="number" min="0" max="100" step="1" value={draft.kind === "won" ? "100" : draft.kind === "lost" ? "0" : draft.probability} onChange={(e) => patch(draft.id, { probability: e.target.value })} disabled={busy || draft.kind !== "open"} required />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-base-content/35">%</span>
                </div>
                <button type="button" disabled={busy} onClick={() => askRemove(draft)} className="btn btn-ghost btn-xs text-error">Delete</button>
              </div>
              {emptying?.id === draft.id && (
                <div className="ml-6 mt-2 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-2.5">
                  <p className="text-xs text-base-content/70">Holds {count(draft.id)} {count(draft.id) === 1 ? "opportunity" : "opportunities"}. Choose the stage {count(draft.id) === 1 ? "it moves" : "they move"} to.</p>
                  <div className="mt-2 flex items-center gap-2">
                    <select aria-label="Stage to move them to" className="h-8 min-w-0 flex-1 rounded-[10px] border border-[var(--border)] bg-base-100 px-2.5 text-xs text-base-content focus:border-[var(--border-focus)] focus:outline-none" value={emptying.moveTo} onChange={(e) => setEmptying({ id: draft.id, moveTo: e.target.value })}>
                      {drafts.filter((row) => row.id !== draft.id).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                    </select>
                    <button type="button" disabled={busy || !emptying.moveTo} onClick={() => void remove(draft.id, emptying.moveTo)} className="btn btn-xs shrink-0 text-error">Move and delete</button>
                    <button type="button" onClick={() => setEmptying(null)} className="btn btn-ghost btn-xs shrink-0">Keep stage</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {drafts.length === 0 && <p className="py-2 text-xs text-base-content/40">No stages yet.</p>}
          <div className="mt-2 flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
            <input aria-label="New stage name" className={`${small} min-w-0 flex-1`} placeholder="New stage name" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (newName.trim()) void add(); } }} />
            <button type="button" disabled={busy || !newName.trim()} onClick={() => void add()} className="btn btn-sm">Add stage</button>
          </div>
          <div className="modal-action mt-2">
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">Close</button>
            <button type="submit" disabled={busy} className="btn btn-primary btn-sm">Save changes</button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
