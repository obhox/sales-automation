import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { ArrowLeft, ArrowRight, Check, CloudCheck, CloudOff, Rocket, SendHorizontal, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, ErrorState, LoadingState } from "@/components/ui";
import { GatePanel } from "@/components/sequence/GatePanel";
import { Lane, type Selection } from "@/components/sequence/Lane";
import { StepPanel } from "@/components/sequence/StepPanel";
import { StepTrialDialog } from "@/components/sequence/Dialogs";
import {
  defaultGate, docFrom, draftOf, findRow, fingerprint, gateOn, isSending, laneItems, removeRow, restoreGate, restoreStep, setGate, type BuilderData, type Doc, type Track,
} from "@/components/sequence/model";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, plural } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { campaignHref, sequenceHref } from "../model";
import { ContextStep, ListStep, SendersStep } from "./Steps";
import { Readiness, SummaryStep } from "./SummaryStep";
import {
  EMPTY_DRAFT, STEPS, draftFrom, nextProblem, railLine, safetyNote, sequenceFacts, stepDone, stepIndex,
  type Draft, type Prelaunch, type SetupData, type SetupOptions, type SetupStep,
} from "./model";

interface OptionsAnswer { options: SetupOptions; ai_available: boolean; default_model: string | null }
type Saved = { state: "unsaved" } | { state: "saving" } | { state: "saved"; at: number } | { state: "failed" };

/**
 * Setting a campaign up, over the campaigns list: six steps with a rail of what has been
 * chosen so far. The campaign is created at the end of the first step and saved as it
 * changes from then on, so it can be closed at any point and picked up again as a draft.
 */
export function CampaignWizard({ open, campaignId, onClose, onChanged }: { open: boolean; campaignId: string | null; onClose: () => void; onChanged: () => void }) {
  // Each time it opens it starts afresh; it stays mounted while closed so the dialog can hand focus back.
  const [round, setRound] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setRound(round + 1);
  }
  return <Wizard key={`${campaignId ?? "new"}:${round}`} open={open} initialId={campaignId} onClose={onClose} onChanged={onChanged} />;
}

function Wizard({ open, initialId, onClose, onChanged }: { open: boolean; initialId: string | null; onClose: () => void; onChanged: () => void }) {
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager") };
  const [id, setId] = useState<string | null>(initialId);
  const [step, setStep] = useState<SetupStep>("list");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<Saved>({ state: "unsaved" });
  const [busy, setBusy] = useState<"next" | "launch" | "draft" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loaded = useRef(false);
  const stored = useRef<string>(JSON.stringify(EMPTY_DRAFT));

  const blank = useApi<OptionsAnswer>(open && !id ? "/api/workflows/setup-options" : null);
  const setup = useApi<SetupData>(open && id ? `/api/workflows/${id}/setup` : null);
  const builder = useApi<BuilderData>(open && id ? `/api/workflows/${id}/builder` : null);
  // The checks are worked out from what is stored, so they are asked for again after each save.
  const prelaunch = useApi<Prelaunch>(open && id && saved.state !== "saving" ? `/api/workflows/${id}/prelaunch` : null, saved.state === "saved" ? { v: saved.at } : undefined, { keepPreviousData: true });
  const options = setup.data?.options ?? blank.data?.options;
  const aiAvailable = setup.data?.ai_available ?? blank.data?.ai_available ?? true;
  const defaultModel = setup.data?.default_model ?? blank.data?.default_model ?? null;

  // The sequence, edited here with the builder's own pieces.
  const [doc, setDoc] = useState<Doc | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [before, setBefore] = useState<Doc | null>(null);
  const [testing, setTesting] = useState<{ ref: string; pick: number } | null>(null);
  const openedVersion = useRef<number | null>(null);
  const published = useMemo(() => (builder.data ? fingerprint(docFrom(builder.data.sequence)) : null), [builder.data]);
  const facts = useMemo(() => (doc ? sequenceFacts(draftOf(doc).steps) : null), [doc]);
  const inFlight = builder.data?.sequence.in_flight ?? 0;

  // Open what is stored, once, and go to the step it was left on.
  useEffect(() => {
    if (!setup.data || loaded.current) return;
    loaded.current = true;
    const opened = draftFrom(setup.data);
    setDraft(opened);
    stored.current = JSON.stringify(opened);
    setStep(setup.data.setup.step);
    setSaved({ state: "saved", at: Date.now() });
  }, [setup.data]);
  useEffect(() => {
    if (!builder.data || openedVersion.current === builder.data.sequence.version) return;
    openedVersion.current = builder.data.sequence.version;
    setDoc(docFrom(builder.data.sequence));
    setSelected(null);
  }, [builder.data]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  async function store(current: Draft, at: SetupStep, campaign = id): Promise<boolean> {
    if (!campaign) return false;
    const body = { name: current.name, prompt: current.prompt, setup: { ...current.setup, step: at }, ai: current.ai };
    setSaved({ state: "saving" });
    try {
      await api(`/api/workflows/${campaign}/setup`, { method: "PUT", body });
      stored.current = JSON.stringify(current);
      setSaved({ state: "saved", at: Date.now() });
      return true;
    } catch (cause) {
      setSaved({ state: "failed" });
      toast.error(errorMessage(cause));
      return false;
    }
  }

  // Kept as it changes, once there is a campaign to keep it on.
  const snapshot = JSON.stringify(draft);
  const stepNow = useRef(step);
  useEffect(() => { stepNow.current = step; }, [step]);
  useEffect(() => {
    if (!id || !loaded.current || !can.member || snapshot === stored.current || !draft.name.trim()) return;
    // Checked again when the moment comes: moving to another step stores everything at once,
    // and this must not then store it a second time under the step that was left.
    const timer = setTimeout(() => { if (snapshot !== stored.current) void store(draft, stepNow.current); }, 800);
    return () => clearTimeout(timer);
  }, [snapshot, id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Make the steps on screen the campaign's steps. A new campaign has nobody part-way through, so this is safe to do as it goes. */
  async function storeSequence(): Promise<boolean> {
    if (!id || !doc || published === null || fingerprint(doc) === published || inFlight > 0) return true;
    try {
      await api(`/api/workflows/${id}/publish`, { method: "POST", body: draftOf(doc) });
      await builder.mutate();
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return false;
    }
  }

  async function go(to: SetupStep) {
    if (busy) return;
    const problem = stepIndex(to) > stepIndex("list") ? nextProblem("list", draft) : null;
    if (problem) {
      toast.error(problem);
      setStep("list");
      return;
    }
    setBusy("next");
    try {
      let campaign = id;
      if (!campaign) {
        const created = await api<{ id: string }>("/api/workflows", { method: "POST", body: { name: draft.name.trim(), prompt: draft.prompt.trim() || undefined } });
        campaign = created.id;
        loaded.current = true;
        setId(campaign);
        onChanged();
        // The address remembers the campaign, so a reload picks the wizard up where it was.
        void router.replace({ pathname: router.pathname, query: { ...Object.fromEntries(Object.entries(router.query).filter(([key]) => key !== "new")), setup: campaign } }, undefined, { shallow: true });
      }
      if (!(await storeSequence())) return;
      if (!(await store(draft, to, campaign))) return;
      setSelected(null);
      setStep(to);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveAsDraft() {
    if (busy) return;
    const problem = !draft.name.trim() ? "Give the campaign a name first" : null;
    if (problem) { toast.error(problem); setStep("list"); return; }
    setBusy("draft");
    try {
      let campaign = id;
      if (!campaign) {
        campaign = (await api<{ id: string }>("/api/workflows", { method: "POST", body: { name: draft.name.trim(), prompt: draft.prompt.trim() || undefined } })).id;
        loaded.current = true;
        setId(campaign);
      }
      if (!(await storeSequence()) || !(await store(draft, step, campaign))) return;
      toast.success("Saved as a draft", { description: "Open it from the campaigns list to carry on." });
      onChanged();
      onClose();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function launch() {
    if (!id || busy) return;
    setBusy("launch");
    try {
      if (!(await storeSequence()) || !(await store(draft, "summary"))) return;
      const result = await api<{ enrolled: number; excluded: number; taken_over: number; skipped_in_other_campaigns: number }>(`/api/workflows/${id}/launch`, { method: "POST", body: {} });
      const notes = [
        result.excluded > 0 ? `${formatCount(result.excluded)} left out as customers or open deals` : "",
        result.skipped_in_other_campaigns > 0 ? `${formatCount(result.skipped_in_other_campaigns)} skipped, in another campaign` : "",
        result.taken_over > 0 ? `${formatCount(result.taken_over)} taken over from another campaign` : "",
      ].filter(Boolean);
      toast.success(`Launched: ${formatCount(result.enrolled)} ${plural(result.enrolled, "contact", "contacts")} enrolled`, notes.length ? { description: `${notes.join("; ")}.` } : undefined);
      onChanged();
      await router.push(campaignHref(id));
    } catch (cause) {
      toast.error(errorMessage(cause));
      void prelaunch.mutate();
    } finally {
      setBusy(null);
    }
  }

  const index = stepIndex(step);
  const current = STEPS[index];
  const previous = STEPS[index - 1];
  const change = (patch: Partial<Draft>) => setDraft((held) => ({ ...held, ...patch }));
  // Said once the senders have been chosen, not before there was anything to check.
  const note = index >= stepIndex("senders") ? safetyNote(prelaunch.data) : null;
  const savedText = saved.state === "saving" ? "Saving…" : saved.state === "failed" ? "Not saved" : saved.state === "saved" ? `Draft saved ${ago(now - saved.at)}` : "Not saved yet";
  const loading = id !== null && (!setup.data || !builder.data || !doc);
  const failed = setup.error ?? builder.error;
  const track: Track | null = step === "linkedin" ? "linkedin" : step === "email" ? "email" : null;

  return (
    <Dialog
      open={open} onOpenChange={(next) => { if (!next) onClose(); }} size="xl" height={740} padded={false} icon={SendHorizontal}
      title={initialId ? draft.name.trim() || "Campaign setup" : "New campaign"} description={`Step ${index + 1} of ${STEPS.length} · ${current.title}`}
      aside={
        <span className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-control px-[9px] text-105 font-medium text-ink-2" aria-live="polite">
          {saved.state === "failed" ? <CloudOff size={12} aria-hidden="true" /> : <CloudCheck size={12} aria-hidden="true" />}
          {savedText}
        </span>
      }
    >
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Setup steps" className="flex w-[262px] shrink-0 flex-col overflow-y-auto border-r border-line bg-subtle py-3.5">
          <p className="flex h-[22px] items-center px-[18px] text-10 font-semibold uppercase tracking-label text-ink-3">Setup steps</p>
          <ol>
            {STEPS.map((entry, position) => {
              const done = stepDone(entry.key, draft, facts, prelaunch.data);
              const active = entry.key === step;
              return (
                <li key={entry.key}>
                  <button
                    type="button" aria-current={active ? "step" : undefined} onClick={() => void go(entry.key)}
                    className={cn("flex h-[54px] w-full items-center gap-2.5 px-3.5 text-left outline-none transition-colors focus-visible:bg-brand-tint", active ? "bg-brand-tint" : "hover:bg-control")}
                  >
                    <span className={cn("inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-11 font-semibold", active ? "bg-brand text-white" : done ? "bg-good-tint text-good" : done === false ? "bg-warn-tint text-warn" : "bg-control text-ink-2")}>
                      {done && !active ? <Check size={13} aria-hidden="true" /> : position + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn("text-12 font-semibold", active ? "text-brand-strong" : "text-ink")}>{entry.name}</span>
                      <span className="truncate text-105 text-ink-3">{railLine(entry.key, draft, options, facts)}</span>
                    </span>
                    {!active && position < index ? <span className="shrink-0 text-11 font-semibold text-brand-strong">Edit</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
          {note ? (
            <div className="px-3.5 pt-3">
              <div className="flex flex-col gap-[5px] rounded-lg bg-surface p-2.5">
                <p className="flex items-center gap-1.5 text-115 font-semibold text-ink">
                  {note.ok ? <ShieldCheck size={13} className="text-good" aria-hidden="true" /> : <ShieldAlert size={13} className="text-warn" aria-hidden="true" />}
                  {note.title}
                </p>
                <p className="text-105 leading-[15px] text-ink-3">{note.body}</p>
              </div>
            </div>
          ) : null}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[13px] p-5">
          <div className="flex shrink-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-15 font-semibold tracking-[-0.15px] text-ink">{current.title}</h3>
              <p className="text-11 text-ink-3">{current.hint}</p>
            </div>
            {step === "summary" ? <Readiness prelaunch={prelaunch.data} /> : null}
          </div>

          {failed && id ? (
            <ErrorState message={errorMessage(failed)} onRetry={() => { void setup.mutate(); void builder.mutate(); }} />
          ) : loading ? (
            <LoadingState label="Opening the campaign" className="flex-1" />
          ) : step === "list" ? (
            <ListStep draft={draft} options={options} onChange={change} />
          ) : step === "context" ? (
            <ContextStep draft={draft} aiAvailable={aiAvailable} defaultModel={defaultModel} onChange={change} />
          ) : step === "senders" ? (
            <SendersStep draft={draft} options={options} facts={facts} onChange={change} />
          ) : step === "summary" && id ? (
            <SummaryStep
              id={id} draft={draft} options={options} facts={facts} prelaunch={prelaunch.data} defaultModel={defaultModel}
              onEdit={(to) => void go(to)} onOverlap={(overlap) => change({ setup: { ...draft.setup, overlap } })}
            />
          ) : track && doc && builder.data && id ? (
            inFlight > 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <p className="text-13 font-semibold text-ink">This campaign is under way</p>
                <p className="max-w-[380px] text-115 leading-[18px] text-ink-2">{formatCount(inFlight)} {plural(inFlight, "contact is", "contacts are")} part-way through its sequence. Change the steps in the sequence builder, which keeps each of them in place.</p>
                <Button asChild className="mt-1"><Link href={sequenceHref(id)}>Open the sequence builder</Link></Button>
              </div>
            ) : (
              <SequenceEditor
                doc={doc} track={track} data={builder.data} id={id} selected={selected} before={before}
                onDoc={setDoc} onSelect={(next) => { setBefore(doc); setSelected(next); }} onTest={setTesting}
              />
            )
          ) : null}
        </div>
      </div>

      <footer className="flex h-16 shrink-0 items-center justify-between gap-3 border-t border-line bg-subtle px-5">
        {previous ? <Button icon={ArrowLeft} disabled={busy !== null} onClick={() => void go(previous.key)}>Back to {previous.back}</Button> : <Button onClick={onClose}>Cancel</Button>}
        <div className="flex items-center gap-2.5">
          {step === "summary" ? <span className="text-11 text-ink-3">{prelaunch.data?.ready ? "Launches at once · first sends in the senders' working hours" : "Clear what blocks it to launch"}</span> : null}
          {can.member ? <Button loading={busy === "draft"} disabled={busy !== null && busy !== "draft"} onClick={() => void saveAsDraft()}>Save as draft</Button> : null}
          {step === "summary" ? (
            <Button
              variant="primary" icon={Rocket} loading={busy === "launch"} disabled={!can.manager || !prelaunch.data?.ready || (busy !== null && busy !== "launch")}
              title={!can.manager ? "A manager launches campaigns" : undefined} onClick={() => void launch()}
            >
              Launch campaign
            </Button>
          ) : (
            <Button variant="primary" iconRight={ArrowRight} loading={busy === "next"} disabled={!can.member || (busy !== null && busy !== "next")} onClick={() => void go(STEPS[index + 1].key)}>Continue</Button>
          )}
        </div>
      </footer>

      {builder.data && doc && id ? <StepTrialDialog open={testing !== null} onClose={() => setTesting(null)} workflowId={id} data={builder.data} row={testing ? findRow(doc, testing.ref) : null} pick={testing?.pick ?? 0} /> : null}
    </div>
    </Dialog>
  );
}

const ago = (ms: number) => (ms < 5000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);

/** One track of the sequence with the panel for whatever is selected, made of the sequence builder's own pieces. */
function SequenceEditor({
  doc, track, data, id, selected, before, onDoc, onSelect, onTest,
}: {
  doc: Doc; track: Track; data: BuilderData; id: string; selected: Selection | null; before: Doc | null;
  onDoc: (doc: Doc) => void; onSelect: (selection: Selection | null) => void; onTest: (testing: { ref: string; pick: number }) => void;
}) {
  const row = selected ? findRow(doc, selected.ref) : null;
  const inTrack = row ? doc[track].includes(row) : false;
  const item = row && inTrack ? laneItems(doc, track).find((entry) => entry.row.ref === row.ref) ?? null : null;
  const gate = selected?.what === "gate" && row && inTrack ? gateOn(doc, row.ref) : null;

  function openGate(ref: string) {
    const source = findRow(doc, ref);
    if (!source) return;
    if (!gateOn(doc, ref)) onDoc(setGate(doc, ref, defaultGate(source)));
    onSelect({ ref, what: "gate" });
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3.5">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto rounded-[10px] border border-line bg-subtle p-3.5">
        <Lane doc={doc} track={track} data={data} selected={selected} readOnly={false} onChange={onDoc} onSelect={onSelect} />
      </div>
      {selected?.what === "step" && item && isSending(item.row) ? (
        <StepPanel
          key={item.row.ref} doc={doc} item={item} track={track} data={data} workflowId={id} readOnly={false}
          onChange={onDoc} onApply={() => onSelect(null)}
          onCancel={() => { if (before) onDoc(restoreStep(doc, before, item.row.ref)); onSelect(null); }}
          onDelete={() => { onDoc(removeRow(doc, item.row.ref)); onSelect(null); }}
          onGate={() => openGate(item.row.ref)} onTest={(pick) => onTest({ ref: item.row.ref, pick })}
        />
      ) : gate && row ? (
        <GatePanel
          key={`gate:${row.ref}`} doc={doc} source={row} gate={gate} track={track} data={data} readOnly={false}
          onChange={onDoc} onApply={() => onSelect(null)}
          onCancel={() => { if (before) onDoc(restoreGate(doc, before, row.ref)); onSelect(null); }}
        />
      ) : (
        <div className="flex w-[364px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-6 text-center">
          <p className="text-125 font-semibold text-ink">Nothing selected</p>
          <p className="text-11 leading-4 text-ink-3">Add a step, or choose one, to write what it says and when it goes out.</p>
        </div>
      )}
    </div>
  );
}
