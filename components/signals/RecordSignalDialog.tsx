import { useState } from "react";
import { useTranslations } from "next-intl";
import { Radar } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { RecordPicker } from "./RecordPicker";
import { SIGNALS_PATH, SIGNAL_TYPES, blankSignal, signalPayload, signalProblem, type SignalForm, type SignalType } from "./model";

/** Record something you learned about a contact or a company. Mounted only while open. */
export function RecordSignalDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("SignalsRecord");
  const [form, setForm] = useState<SignalForm>(blankSignal());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "title" | "score" | "about" | "form"; message: string } | null>(null);
  const set = (patch: Partial<SignalForm>) => setForm((current) => ({ ...current, ...patch }));

  async function save() {
    const found = signalProblem(form);
    if (found) return setProblem({...found, message: t(found.field === "title" ? "titleRequired" : found.field === "score" ? "scoreInvalid" : "aboutRequired")});
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
      title={t("title")}
      description={t("desc")}
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{t("record")}</Button>
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
          <Field label={t("kind")}>
            {(id) => <Select<SignalType> id={id} className="w-full" value={form.type} onChange={(type) => set({ type })} options={SIGNAL_TYPES.map((type) => ({ value: type, label: t(type === "job_change" ? "job" : type === "funding" ? "funding" : type === "hiring" ? "hiring" : type === "technology" ? "tech" : type === "product_intent" ? "intent" : "custom") }))} />}
          </Field>
          <Field label={t("what")} error={problem?.field === "title" ? problem.message : null}>
            {(id) => <Input id={id} data-autofocus maxLength={200} placeholder={t("placeholder")} value={form.title} invalid={problem?.field === "title"} onChange={(event) => set({ title: event.target.value })} />}
          </Field>
        </div>
        <Field label={t("about")} error={problem?.field === "about" ? problem.message : null} hint={t(form.about?.kind === "company" ? "companyHint" : "contactHint")}>
          {() => <RecordPicker kinds={["contact", "company"]} value={form.about} onChange={(about) => set({ about })} placeholder={t("search")} invalid={problem?.field === "about"} />}
        </Field>
        <Field label={t("more")} aside={t("optional")}>
          {(id) => <Textarea id={id} rows={3} maxLength={1000} placeholder={t("morePlaceholder")} value={form.description} onChange={(event) => set({ description: event.target.value })} />}
        </Field>
        <Field label={t("score")} error={problem?.field === "score" ? problem.message : null} hint={t("scoreHint")}>
          {(id) => <Input id={id} inputMode="numeric" className="w-[100px]" value={form.score} invalid={problem?.field === "score"} onFocus={(event) => event.target.select()} onChange={(event) => set({ score: event.target.value.replace(/[^\d.]/g, "") })} />}
        </Field>
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
