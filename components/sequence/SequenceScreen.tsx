import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Check, CircleDot, Eye, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, ErrorState, Pill, Skeleton, TextAction, confirm } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative, plural } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { PreviewDialog, TestSendDialog } from "./Dialogs";
import { GatePanel } from "./GatePanel";
import { Lane, type Selection } from "./Lane";
import { StepPanel } from "./StepPanel";
import {
  TRACKS, defaultGate, docFrom, draftOf, findRow, fingerprint, gateOn, isSending, laneItems, removeRow, restoreGate, restoreStep, sequenceProblems, setGate,
  type BuilderData, type Doc, type Track,
} from "./model";

interface Published { version: number; in_flight: number; moved: number; created: string[]; deleted: string[] }
type DraftState = "none" | "saving" | "saved" | "failed";

/** A campaign's Sequence tab: its two tracks on a canvas, the selected step's settings beside it, and saving it as the running sequence. */
export function SequenceScreen() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const { data, error, mutate } = useApi<BuilderData>(id ? `/api/workflows/${id}/builder` : null);
  const can = { member: useCan("member"), manager: useCan("manager") };

  const [doc, setDoc] = useState<Doc | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  /** The sequence as it was when the open panel was opened: what Cancel goes back to. */
  const [before, setBefore] = useState<Doc | null>(null);
  const [draftState, setDraftState] = useState<DraftState>("none");
  const [busy, setBusy] = useState<"publish" | "discard" | "run" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [testing, setTesting] = useState<{ ref: string; pick: number } | null>(null);
  /** Which campaign and published version the editor was opened from. A new version reopens it. */
  const openedFrom = useRef<string | null>(null);
  /** The fingerprint of what the server holds: the stored draft, or the published sequence when there is none. */
  const stored = useRef<string | null>(null);
  const latest = useRef<{ doc: Doc; print: string } | null>(null);

  const published = useMemo(() => (data ? fingerprint(docFrom(data.sequence)) : null), [data]);
  const print = useMemo(() => (doc ? fingerprint(doc) : null), [doc]);
  const dirty = print !== null && published !== null && print !== published;
  const readOnly = !can.member || data?.campaign.status === "archived";

  useEffect(() => {
    if (!data || !id) return;
    const key = `${id}:${data.sequence.version}`;
    if (openedFrom.current === key) return;
    openedFrom.current = key;
    // A draft that does not carry settings keeps the published ones.
    const opened = docFrom(data.draft ? { ...data.draft.sequence, settings: { ...data.sequence.settings, ...(data.draft.sequence.settings ?? {}) } } : data.sequence);
    setDoc(opened);
    setSelected(null);
    stored.current = fingerprint(opened);
    setDraftState(data.draft ? "saved" : "none");
  }, [data, id]);

  async function storeDraft(current: Doc, currentPrint: string) {
    if (!id) return;
    setDraftState("saving");
    try {
      // Back to exactly what is published: there is nothing left to keep.
      if (currentPrint === published) await api(`/api/workflows/${id}/draft`, { method: "DELETE" });
      else await api(`/api/workflows/${id}/draft`, { method: "PUT", body: draftOf(current) });
      stored.current = currentPrint;
      setDraftState(currentPrint === published ? "none" : "saved");
    } catch {
      setDraftState("failed");
    }
  }

  // Every change is kept as a draft shortly after it is made, so closing the tab loses nothing.
  useEffect(() => {
    if (!doc || print === null) return;
    latest.current = { doc, print };
    if (readOnly || print === stored.current) return;
    const timer = setTimeout(() => void storeDraft(doc, print), 900);
    return () => clearTimeout(timer);
  }, [print]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving within that moment: keep what was just typed.
  useEffect(() => () => {
    const last = latest.current;
    if (last && id && last.print !== stored.current) void api(`/api/workflows/${id}/draft`, { method: "PUT", body: draftOf(last.doc) }).catch(() => undefined);
  }, [id]);

  function select(next: Selection | null) {
    setBefore(doc);
    setSelected(next);
  }

  async function publish() {
    if (!doc || !data || !id || busy) return;
    const problems = sequenceProblems(doc, data.templates, data.custom_fields.map((field) => field.key));
    if (problems.length > 0) {
      toast.error(problems[0].message, problems.length > 1 ? { description: `And ${problems.length - 1} more to fix before this can be saved.` } : undefined);
      if (problems[0].ref) select({ ref: problems[0].ref, what: "step" });
      return;
    }
    const inFlight = data.sequence.in_flight;
    if (inFlight > 0 || data.draft?.stale) {
      const ok = await confirm({
        title: inFlight > 0 ? `Save with ${formatCount(inFlight)} ${plural(inFlight, "contact", "contacts")} in flight?` : "Replace the running sequence?",
        body: [
          inFlight > 0 ? "Each contact stays on the step they are on, wherever it has moved to. A contact on a step you removed goes on to the next one. Nothing already sent is sent again." : "",
          data.draft?.stale ? "The running sequence was changed after this draft was started. Saving replaces it with what is on screen." : "",
        ].filter(Boolean).join(" "),
        confirmLabel: "Save sequence",
      });
      if (!ok) return;
    }
    setBusy("publish");
    try {
      const result = await api<Published>(`/api/workflows/${id}/publish`, { method: "POST", body: draftOf(doc) });
      toast.success("Sequence saved", {
        description: result.in_flight > 0 ? `${formatCount(result.in_flight)} in flight${result.moved > 0 ? `, ${formatCount(result.moved)} carried to a step that moved` : ""}.` : undefined,
      });
      openedFrom.current = null;
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof ApiError && cause.requiredRole === "manager" ? "A manager publishes changes to a running campaign. Your draft is kept for them." : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!id || busy) return;
    const ok = await confirm({ title: "Discard your changes?", body: "The sequence goes back to what is running now. This cannot be undone.", confirmLabel: "Discard changes", tone: "danger" });
    if (!ok) return;
    setBusy("discard");
    try {
      await api(`/api/workflows/${id}/draft`, { method: "DELETE" });
      latest.current = null;
      openedFrom.current = null;
      await mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function setRunning(action: "pause" | "resume") {
    if (!id || busy) return;
    setBusy("run");
    try {
      const result = await api<{ done: number; results: Array<{ ok: boolean; error?: string }> }>("/api/workflows/bulk", { method: "POST", body: { action, ids: [id] } });
      if (result.done > 0) toast.success(action === "pause" ? "Campaign paused" : "Campaign resumed");
      else toast.error(result.results[0]?.error ?? "That could not be done");
      await mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function deleteStep(ref: string) {
    if (!doc || !data) return;
    const row = findRow(doc, ref);
    if (!row) return;
    const standing = data.sequence.standing[ref] ?? 0;
    const sent = data.figures.steps[ref]?.sent ?? 0;
    if (standing > 0 || sent > 0) {
      const ok = await confirm({
        title: "Delete this step?",
        body: `${standing > 0 ? `${formatCount(standing)} ${plural(standing, "contact is", "contacts are")} on it now and will go on to the next step when you save. ` : ""}What it has already sent stays in the campaign's figures.`,
        confirmLabel: "Delete step", tone: "danger",
      });
      if (!ok) return;
    }
    setDoc(removeRow(doc, ref));
    setSelected(null);
  }

  function openGate(ref: string) {
    if (!doc) return;
    const row = findRow(doc, ref);
    if (!row) return;
    // Cancel in the condition panel goes back to before it was added.
    setBefore(doc);
    if (!gateOn(doc, ref)) setDoc(setGate(doc, ref, defaultGate(row)));
    setSelected({ ref, what: "gate" });
  }

  const campaign = data?.campaign;
  const canRun = can.manager && campaign?.run && (campaign.status === "active" || campaign.status === "paused");
  const selectedRow = doc && selected ? findRow(doc, selected.ref) : null;
  const selectedTrack: Track | null = doc && selectedRow ? (doc.email.includes(selectedRow) ? "email" : "linkedin") : null;
  const selectedItem = doc && selectedRow && selectedTrack ? laneItems(doc, selectedTrack).find((item) => item.row.ref === selectedRow.ref) ?? null : null;
  const selectedGate = doc && selected?.what === "gate" && selectedRow ? gateOn(doc, selectedRow.ref) : null;
  const notFound = error?.status === 404;

  return (
    <CampaignFrame
      id={id ?? ""} campaign={campaign} tab="sequence" padded={false}
      meta={dirty ? <Pill tone="warn" icon={CircleDot}>Unsaved changes</Pill> : null}
      actions={data && doc ? (
        <>
          <Button variant="ghost" icon={Eye} onClick={() => setPreviewing(true)}>Preview as prospect</Button>
          {canRun ? (
            campaign.status === "active"
              ? <Button icon={Pause} loading={busy === "run"} onClick={() => void setRunning("pause")}>Pause</Button>
              : <Button icon={Play} loading={busy === "run"} onClick={() => void setRunning("resume")}>Resume</Button>
          ) : null}
          {readOnly ? null : (
            <Button
              variant="primary" icon={Check} loading={busy === "publish"} disabled={!dirty || !data.can_publish}
              title={!data.can_publish ? "A manager publishes changes while contacts are part-way through the sequence" : !dirty ? "Nothing has changed since the last save" : undefined}
              onClick={() => void publish()}
            >
              Save sequence
            </Button>
          )}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      ) : null}
      aside={data ? (
        <>
          <Fact label="Enrolled" value={formatCount(data.campaign.enrolled)} />
          <Fact label="In sequence" value={formatCount(data.sequence.in_flight)} />
          <Fact label="Completed" value={formatCount(data.campaign.done)} />
          <span className="h-4 w-px bg-line" aria-hidden="true" />
          <span className="text-11 text-ink-3" aria-live="polite">
            {draftState === "saving" ? "Keeping your draft…" : draftState === "failed" ? "Your draft could not be kept" : dirty ? (draftState === "saved" ? "Draft kept, not yet saved" : "Keeping your draft…") : data.sequence.published_at ? `Last published ${formatRelative(data.sequence.published_at)}` : data.sequence.steps.length === 0 ? "No steps yet" : ""}
          </span>
          {dirty && !readOnly ? <TextAction onClick={() => void discard()}>Discard changes</TextAction> : null}
        </>
      ) : null}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-5">
        {error && !data ? (
          <ErrorState message={notFound ? "This campaign could not be found. It may have been deleted." : errorMessage(error)} onRetry={notFound ? undefined : () => void mutate()} />
        ) : !data || !doc ? (
          <div className="flex min-h-0 flex-1 gap-[18px] rounded-[10px] border border-line bg-subtle p-4" aria-busy="true">
            {TRACKS.map((track) => (
              <div key={track} className="flex flex-1 flex-col gap-2.5">
                <Skeleton className="h-[30px] w-40" />
                <Skeleton className="h-[52px] w-full" />
                <Skeleton className="h-[52px] w-full" />
                <Skeleton className="h-[52px] w-full" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {data.draft?.stale && dirty ? (
              <Alert tone="warn" title="The running sequence changed after this draft was started">
                {data.draft.updated_by_name ? `${data.draft.updated_by_name} began this draft` : "This draft was begun"} {formatRelative(data.draft.updated_at)}, and someone has saved the sequence since. Saving now replaces theirs with what is on screen; discarding goes back to theirs.
              </Alert>
            ) : null}
            {dirty && !data.can_publish && !readOnly ? (
              <Alert tone="warn" title={`${formatCount(data.sequence.in_flight)} ${plural(data.sequence.in_flight, "contact is", "contacts are")} part-way through this sequence`}>
                A manager saves changes to a campaign that is under way. Your draft is kept here for them.
              </Alert>
            ) : null}
            {readOnly && campaign?.status === "archived" ? <Alert tone="warn" title="This campaign is archived">Bring it back from the campaigns list to change its sequence.</Alert> : null}

            <div className="flex min-h-0 flex-1 gap-3.5">
              <div className="flex min-h-0 min-w-0 flex-1 gap-[18px] overflow-y-auto rounded-[10px] border border-line bg-subtle p-4">
                {TRACKS.map((track) => (
                  <Lane key={track} doc={doc} track={track} data={data} selected={selected} readOnly={readOnly} onChange={setDoc} onSelect={select} />
                ))}
              </div>

              {selected?.what === "step" && selectedItem && selectedTrack && isSending(selectedItem.row) ? (
                <StepPanel
                  key={selectedItem.row.ref} doc={doc} item={selectedItem} track={selectedTrack} data={data} workflowId={id!} readOnly={readOnly}
                  onChange={setDoc} onApply={() => setSelected(null)}
                  onCancel={() => { if (before) setDoc(restoreStep(doc, before, selectedItem.row.ref)); setSelected(null); }}
                  onDelete={() => void deleteStep(selectedItem.row.ref)}
                  onGate={() => openGate(selectedItem.row.ref)}
                  onTest={(pick) => setTesting({ ref: selectedItem.row.ref, pick })}
                />
              ) : null}
              {selectedGate && selectedRow && selectedTrack ? (
                <GatePanel
                  key={`gate:${selectedRow.ref}`} doc={doc} source={selectedRow} gate={selectedGate} track={selectedTrack} data={data} readOnly={readOnly}
                  onChange={setDoc} onApply={() => setSelected(null)}
                  onCancel={() => { if (before) setDoc(restoreGate(doc, before, selectedRow.ref)); setSelected(null); }}
                />
              ) : null}
            </div>

            <PreviewDialog open={previewing} onClose={() => setPreviewing(false)} workflowId={id!} data={data} steps={draftOf(doc).steps} />
            <TestSendDialog open={testing !== null} onClose={() => setTesting(null)} workflowId={id!} data={data} row={testing ? findRow(doc, testing.ref) : null} pick={testing?.pick ?? 0} />
          </>
        )}
      </div>
    </CampaignFrame>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-[5px]">
      <span className="text-11 text-ink-3">{label}</span>
      <span className="text-115 font-semibold text-ink">{value}</span>
    </span>
  );
}
