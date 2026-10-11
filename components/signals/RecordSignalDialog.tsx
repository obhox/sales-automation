import { useState } from "react";
import { Radar } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { RecordPicker } from "./RecordPicker";
import { SIGNALS_PATH, SIGNAL_TYPES, SIGNAL_TYPE_LABELS, aboutHint, blankSignal, signalPayload, signalProblem, type SignalForm, type SignalType } from "./model";

/** Record something you learned about a contact or a company. Mounted only while open. */
export function RecordSignalDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<SignalForm>(blankSignal());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "title" | "score" | "about" | "form"; message: string } | null>(null);
  const set = (patch: Partial<SignalForm>) => setForm((current) => ({ ...current, ...patch }));

  async function save() {
    const found = signalProblem(form);
    if (found) return setProblem(found);
    setSaving(true);
    setProblem(null);
    try {
      await api(SIGNALS_PATH, { method: "POST", body: signalPayload(form) });
      onSaved();
      onClose();
    } catch (cause) {
      setProblem({ field: "form", message: errorMessage(cause) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      icon={Radar}
      title="Record a signal"
      description="Something that happened which makes now a good time to write"
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>Record signal</Button>
          </div>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {problem?.field === "form" ? <Alert tone="bad">{problem.message}</Alert> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Kind">
            {(id) => <Select<SignalType> id={id} className="w-full" value={form.type} onChange={(type) => set({ type })} options={SIGNAL_TYPES.map((type) => ({ value: type, label: SIGNAL_TYPE_LABELS[type] }))} />}
          </Field>
          <Field label="What happened" error={problem?.field === "title" ? problem.message : null}>
            {(id) => <Input id={id} data-autofocus maxLength={200} placeholder="Moved to Head of Sales at Initech" value={form.title} invalid={problem?.field === "title"} onChange={(event) => set({ title: event.target.value })} />}
          </Field>
        </div>
        <Field label="Who it is about" error={problem?.field === "about" ? problem.message : null} hint={aboutHint(form)}>
          {() => <RecordPicker kinds={["contact", "company"]} value={form.about} onChange={(about) => set({ about })} placeholder="Search contacts and companies" invalid={problem?.field === "about"} />}
        </Field>
        <Field label="More about it" aside="Optional">
          {(id) => <Textarea id={id} rows={3} maxLength={1000} placeholder="Where you saw it, and why it matters" value={form.description} onChange={(event) => set({ description: event.target.value })} />}
        </Field>
        <Field label="Score" error={problem?.field === "score" ? problem.message : null} hint="From 0 to 100: how strong a reason to write this is. A rule can ask for a least score.">
          {(id) => <Input id={id} inputMode="numeric" className="w-[100px]" value={form.score} invalid={problem?.field === "score"} onFocus={(event) => event.target.select()} onChange={(event) => set({ score: event.target.value.replace(/[^\d.]/g, "") })} />}
        </Field>
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
