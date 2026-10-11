import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, IconButton, Input, Select, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { plural } from "@/lib/client/format";
import { createStage, deleteStage, reorderStages, setAutoOpportunity, updateStage } from "./api";
import { STAGE_KINDS, probabilityFrom, stageKind, type Stage, type StageKind } from "./model";

interface Row { id: string; isNew: boolean; name: string; probability: string; kind: StageKind; deals: number }

let made = 0;

/**
 * The pipeline's shape: its stages, their order, the chance each gives a deal, and which
 * of them count as won or lost. Also whether a positive reply opens an opportunity.
 * Changes to the stages are saved together; deleting a stage happens at once.
 */
export function StagesDialog({ stages, autoOpportunity, onClose, onChanged }: { stages: Stage[]; autoOpportunity: boolean; onClose: () => void; onChanged: () => void }) {
  const original = [...stages].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  // How many deals a stage holds is counted across every owner, not just the ones the board is filtered to.
  const [rows, setRows] = useState<Row[]>(() => original.map((stage) => ({ id: stage.id, isNew: false, name: stage.name, probability: String(stage.probability), kind: stageKind(stage), deals: stage.opportunity_count })));
  const [removing, setRemoving] = useState<{ row: Row; moveTo: string | undefined } | null>(null);
  const [auto, setAuto] = useState(autoOpportunity);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (id: string, patch: Partial<Row>) => { setProblem(null); setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row))); };
  const shift = (index: number, by: -1 | 1) => setRows((current) => {
    const next = [...current];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    return next;
  });

  function addRow() {
    const id = `new-${++made}`;
    setRows((current) => [...current, { id, isNew: true, name: "", probability: "0", kind: "open", deals: 0 }]);
  }

  async function save() {
    if (rows.some((row) => !row.name.trim())) return setProblem("Every stage needs a name.");
    if (rows.some((row) => probabilityFrom(row.probability) === null)) return setProblem("A stage's chance is a whole number from 0 to 100.");
    setProblem(null);
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const row of rows) {
        const probability = probabilityFrom(row.probability)!;
        if (row.isNew) {
          ids.push((await createStage({ name: row.name.trim(), probability, kind: row.kind })).id);
          continue;
        }
        ids.push(row.id);
        const before = original.find((stage) => stage.id === row.id);
        if (before && (before.name !== row.name.trim() || before.probability !== probability || stageKind(before) !== row.kind)) {
          await updateStage(row.id, { name: row.name.trim(), probability, kind: row.kind });
        }
      }
      if (ids.join() !== original.map((stage) => stage.id).join()) await reorderStages(ids);
      toast.success("Stages saved");
      onChanged();
      onClose();
    } catch (cause) {
      // Some of it may have been saved; show the pipeline as it now is.
      onChanged();
      toast.error(errorMessage(cause));
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!removing) return;
    const { row, moveTo } = removing;
    if (row.isNew) {
      setRows((current) => current.filter((item) => item.id !== row.id));
      return setRemoving(null);
    }
    setBusy(true);
    try {
      await deleteStage(row.id, row.deals > 0 ? moveTo : undefined);
      setRows((current) => current.filter((item) => item.id !== row.id).map((item) => (item.id === moveTo ? { ...item, deals: item.deals + row.deals } : item)));
      setRemoving(null);
      toast.success("Stage deleted");
      onChanged();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function toggleAuto(on: boolean) {
    setAuto(on);
    try {
      await setAutoOpportunity(on);
      onChanged();
    } catch (cause) {
      setAuto(!on);
      toast.error(errorMessage(cause));
    }
  }

  const elsewhere = removing ? rows.filter((row) => !row.isNew && row.id !== removing.row.id) : [];
  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title="Edit stages" icon={SlidersHorizontal} size="lg" description="The stages a deal passes through, in order."
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save stages</Button></span></>}
    >
      <div className="flex flex-col gap-4">
        {problem ? <Alert tone="bad" title={problem} /> : null}
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-[52px_1fr_92px_120px_28px] items-center gap-2 px-1 text-10 font-semibold uppercase tracking-label text-ink-3">
            <span>Order</span><span>Name</span><span>Chance</span><span>Counts as</span><span />
          </div>
          <ul className="flex flex-col gap-1.5">
            {rows.map((row, index) => (
              <li key={row.id} className="grid grid-cols-[52px_1fr_92px_120px_28px] items-center gap-2">
                <span className="flex items-center">
                  <IconButton icon={ArrowUp} label={`Move ${row.name || "this stage"} earlier`} size={24} disabled={index === 0} onClick={() => shift(index, -1)} />
                  <IconButton icon={ArrowDown} label={`Move ${row.name || "this stage"} later`} size={24} disabled={index === rows.length - 1} onClick={() => shift(index, 1)} />
                </span>
                <Input aria-label="Stage name" value={row.name} onChange={(event) => change(row.id, { name: event.target.value })} placeholder="Stage name" maxLength={60} invalid={Boolean(problem) && !row.name.trim()} />
                <Input aria-label={`Chance for ${row.name || "this stage"}, in percent`} inputMode="numeric" value={row.probability} onChange={(event) => change(row.id, { probability: event.target.value })} trailing={<span className="text-11 text-ink-3">%</span>} invalid={Boolean(problem) && probabilityFrom(row.probability) === null} />
                <Select
                  label={`What ${row.name || "this stage"} counts as`} className="w-full" value={row.kind} options={STAGE_KINDS}
                  // A deal in a won stage is certain and one in a lost stage is not coming: the chance follows, and can still be typed over.
                  onChange={(kind) => change(row.id, { kind, probability: kind === "won" ? "100" : kind === "lost" ? "0" : row.probability })}
                />
                <IconButton icon={Trash2} label={`Delete ${row.name || "this stage"}`} size={24} onClick={() => setRemoving({ row, moveTo: undefined })} />
              </li>
            ))}
          </ul>
          {rows.length === 0 ? <p className="px-1 py-2 text-115 text-ink-2">No stages yet. Add the first one.</p> : null}
          <div><Button size="sm" icon={Plus} onClick={addRow}>Add a stage</Button></div>
        </div>

        {removing ? (
          <Alert
            tone="warn"
            title={removing.row.deals > 0 ? `${removing.row.name} holds ${removing.row.deals} ${plural(removing.row.deals, "opportunity", "opportunities")}` : `Delete ${removing.row.name || "this stage"}?`}
            actions={
              <>
                {removing.row.deals > 0 ? (
                  <Select label="Stage to move them to" size="sm" placeholder="Move them to…" value={removing.moveTo} onChange={(moveTo) => setRemoving({ ...removing, moveTo })} options={elsewhere.map((row) => ({ value: row.id, label: row.name }))} />
                ) : null}
                <Button size="sm" variant="danger" loading={busy} disabled={removing.row.deals > 0 && !removing.moveTo} onClick={() => void remove()}>Delete stage</Button>
                <Button size="sm" onClick={() => setRemoving(null)}>Keep it</Button>
              </>
            }
          >
            {removing.row.deals > 0 ? "Choose the stage they go to. A stage that has not been saved yet cannot take them." : "This happens at once and cannot be undone."}
          </Alert>
        ) : null}

        <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor="auto-opportunity" className="text-12 font-semibold text-ink">Open an opportunity when a contact replies positively</label>
            <p className="text-11 leading-4 text-ink-2">It goes in the first open stage, named for the contact&rsquo;s company, unless the contact already has one open. The task to answer them is made either way.</p>
          </div>
          <Switch id="auto-opportunity" checked={auto} onChange={(on) => void toggleAuto(on)} />
        </div>
      </div>
    </Dialog>
  );
}
