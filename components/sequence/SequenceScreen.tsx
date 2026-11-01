import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import {useTranslations} from "next-intl";
import { Check, CircleDot, Eye, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, ErrorState, Pill, Skeleton, TextAction, confirm } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { PreviewDialog, StepTrialDialog } from "./Dialogs";
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
  const t = useTranslations("Sequence");
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
      toast.error(problems[0].message, problems.length > 1 ? { description: t("fixMore", {count: problems.length - 1}) } : undefined);
      if (problems[0].ref) select({ ref: problems[0].ref, what: "step" });
      return;
    }
    const inFlight = data.sequence.in_flight;
    if (inFlight > 0 || data.draft?.stale) {
      const ok = await confirm({
        title: inFlight > 0 ? t("saveWithContacts", {count: formatCount(inFlight)}) : t("replaceRunning"),
        body: [
          inFlight > 0 ? t("contactsContinue") : "",
          data.draft?.stale ? t("staleDraft") : "",
        ].filter(Boolean).join(" "),
        confirmLabel: t("save"),
      });
      if (!ok) return;
    }
    setBusy("publish");
    try {
      const result = await api<Published>(`/api/workflows/${id}/publish`, { method: "POST", body: draftOf(doc) });
      toast.success(t("sequenceSaved"), {
        description: result.in_flight > 0 ? t("movedContacts", {count: formatCount(result.in_flight), moved: result.moved > 0 ? t("movedPart", {count: formatCount(result.moved)}) : ""}) : undefined,
      });
      openedFrom.current = null;
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof ApiError && cause.requiredRole === "manager" ? t("managerNeeded") : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!id || busy) return;
    const ok = await confirm({ title: t("discardTitle"), body: t("discardBody"), confirmLabel: t("discardConfirm"), tone: "danger" });
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
      if (result.done > 0) toast.success(action === "pause" ? t("campaignPaused") : t("campaignResumed"));
      else toast.error(result.results[0]?.error ?? t("actionFailed"));
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
        title: t("deleteTitle"),
        body: standing > 0 ? t("deleteBody", {count: formatCount(standing)}) : t("deleteNoContacts"),
        confirmLabel: t("deleteStep"), tone: "danger",
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
  const testingRow = doc && testing ? findRow(doc, testing.ref) : null;
  const selectedRow = doc && selected ? findRow(doc, selected.ref) : null;
  const selectedTrack: Track | null = doc && selectedRow ? (doc.email.includes(selectedRow) ? "email" : "linkedin") : null;
  const selectedItem = doc && selectedRow && selectedTrack ? laneItems(doc, selectedTrack).find((item) => item.row.ref === selectedRow.ref) ?? null : null;
  const selectedGate = doc && selected?.what === "gate" && selectedRow ? gateOn(doc, selectedRow.ref) : null;
  const notFound = error?.status === 404;

  return (
    <CampaignFrame
      id={id ?? ""} campaign={campaign} tab="sequence" padded={false}
      meta={dirty ? <Pill tone="warn" icon={CircleDot}>{t("unsaved")}</Pill> : null}
      actions={data && doc ? (
        <>
          <Button variant="ghost" icon={Eye} onClick={() => setPreviewing(true)}>{t("preview")}</Button>
          {canRun ? (
            campaign.status === "active"
              ? <Button icon={Pause} loading={busy === "run"} onClick={() => void setRunning("pause")}>{t("pause")}</Button>
              : <Button icon={Play} loading={busy === "run"} onClick={() => void setRunning("resume")}>{t("resume")}</Button>
          ) : null}
          {readOnly ? null : (
            <Button
              variant="primary" icon={Check} loading={busy === "publish"} disabled={!dirty || !data.can_publish}
              title={!data.can_publish ? t("managerPublish") : !dirty ? t("unchanged") : undefined}
              onClick={() => void publish()}
            >
              {t("save")}
            </Button>
          )}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      ) : null}
      aside={data ? (
        <>
          <Fact label={t("enrolled")} value={formatCount(data.campaign.enrolled)} />
          <Fact label={t("inSequence")} value={formatCount(data.sequence.in_flight)} />
          <Fact label={t("completed")} value={formatCount(data.campaign.done)} />
          <span className="h-4 w-px bg-line" aria-hidden="true" />
          <span className="text-11 text-ink-3" aria-live="polite">
            {draftState === "saving" ? t("keepingDraft") : draftState === "failed" ? t("draftFailed") : dirty ? (draftState === "saved" ? t("draftKept") : t("keepingDraft")) : data.sequence.published_at ? t("lastPublished", {relative: formatRelative(data.sequence.published_at)}) : data.sequence.steps.length === 0 ? t("noSteps") : ""}
          </span>
          {dirty && !readOnly ? <TextAction onClick={() => void discard()}>{t("discard")}</TextAction> : null}
        </>
      ) : null}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-5">
        {error && !data ? (
          <ErrorState message={notFound ? t("campaignNotFound") : errorMessage(error)} onRetry={notFound ? undefined : () => void mutate()} />
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
              <Alert tone="warn" title={t("draftChangedTitle")}>
                {data.draft.updated_by_name ? t("draftChangedBy", {name: data.draft.updated_by_name, relative: formatRelative(data.draft.updated_at)}) : t("draftChangedBody", {relative: formatRelative(data.draft.updated_at)})}
              </Alert>
            ) : null}
            {dirty && !data.can_publish && !readOnly ? (
              <Alert tone="warn" title={t("contactsWarning", {count: formatCount(data.sequence.in_flight)})}>
                {t("contactsWarningBody")}
              </Alert>
            ) : null}
            {readOnly && campaign?.status === "archived" ? <Alert tone="warn" title={t("archived")}>{t("archivedHelp")}</Alert> : null}

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
            <StepTrialDialog open={testing !== null} onClose={() => setTesting(null)} workflowId={id!} data={data} row={testingRow} pick={testing?.pick ?? 0} />
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
