import { useState } from "react";
import {useTranslations} from "next-intl";
import { FileText } from "lucide-react";
import { MessageEditor } from "@/components/sequence/MessageEditor";
import { mergeTags } from "@/components/sequence/model";
import { Alert, Button, Dialog, Field, Input, Segmented } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { TEMPLATES_PATH, blankForm, formOf, formProblem, payloadOf, templatePath, usedIn, type Channel, type LibraryTemplate, type TemplateForm } from "./model";

interface CustomField { key: string; name: string }

/**
 * Write a template, or change one. Mounted only while open, so it starts from the
 * template's own words. `readOnly` shows it to someone who may not change it.
 */
export function TemplateDialog({ template, startFrom, categories, readOnly, onClose, onSaved }: {
  /** The template being changed. Null: a new one. */
  template: LibraryTemplate | null;
  /** For a new one: words to begin from (a copy), or the channel the list is showing. */
  startFrom?: Partial<TemplateForm>;
  categories: string[];
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("TemplateDialog");
  const [form, setForm] = useState<TemplateForm>(template ? formOf(template) : { ...blankForm(), ...startFrom });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "name" | "subject" | "body" | "form"; message: string } | null>(null);
  const customFields = useApi<CustomField[]>("/api/platform/custom-fields").data ?? [];
  const email = form.channel === "email";
  const set = (patch: Partial<TemplateForm>) => setForm((current) => ({ ...current, ...patch }));
  const offered = template?.figures && template.figures.steps > 0 ? usedIn(template.figures) : null;

  async function save() {
    const found = formProblem(form);
    if (found) return setProblem(found);
    setSaving(true);
    setProblem(null);
    try {
      if (template) await api(templatePath(template.id), { method: "PUT", body: payloadOf(form) });
      else await api(TEMPLATES_PATH, { method: "POST", body: payloadOf(form) });
      onSaved(template ? t("saved", {name: form.name.trim()}) : t("added", {name: form.name.trim()}));
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
      size="lg"
      icon={FileText}
      title={readOnly ? form.name : template ? t("edit") : t("new")}
      description={readOnly ? `${email ? "Email" : "LinkedIn message"}${form.category ? ` · ${form.category}` : ""}` : t("description")}
      footer={
        readOnly ? (
          <>
            <span className="text-105 text-ink-3">{t("readOnlyHint")}</span>
            <Button variant="primary" onClick={onClose}>{t("close")}</Button>
          </>
        ) : (
          <>
            <span className="text-105 text-ink-3">{offered ? t("usedIn", {where: offered}) : t("stepNote")}</span>
            <div className="flex items-center gap-2">
              <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>{template ? t("save") : t("add")}</Button>
            </div>
          </>
        )
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
        {readOnly ? null : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <Field label={t("name")} error={problem?.field === "name" ? problem.message : null}>
              {(id) => <Input id={id} data-autofocus maxLength={200} placeholder="Intro after a funding round" value={form.name} invalid={problem?.field === "name"} onChange={(event) => set({ name: event.target.value })} />}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-105 font-semibold text-ink-2">{t("channel")}</span>
              <Segmented<Channel> label={t("channel")} value={form.channel} onChange={(channel) => set({ channel })} options={[{ value: "linkedin", label: "LinkedIn" }, { value: "email", label: "Email" }]} />
            </div>
          </div>
        )}
        {readOnly ? null : (
          <Field label={t("category")} aside={t("optional")} hint={t("categoryHint")}>
            {(id) => (
              <>
                <Input id={id} maxLength={80} placeholder="Openers" list={`${id}-categories`} value={form.category} onChange={(event) => set({ category: event.target.value })} />
                <datalist id={`${id}-categories`}>{categories.map((category) => <option key={category} value={category} />)}</datalist>
              </>
            )}
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <MessageEditor
            label={t("message")} body={form.body} onBody={(body) => set({ body })}
            subject={email ? form.subject : undefined} onSubject={email ? (subject) => set({ subject }) : undefined} subjectPlaceholder="Quick question about {{company}}"
            tags={mergeTags(customFields, { email })} rows={10} disabled={readOnly}
            placeholder={email ? "Hi {{first_name}}," : "Hi {{first_name}}, I saw that {{company}}…"}
          />
          {problem?.field === "subject" || problem?.field === "body" ? <p className="text-105 text-bad" role="alert">{problem.message}</p> : null}
          {!readOnly && !email && template?.channel === "email" && template.subject ? <p className="text-105 text-ink-3">{t("noSubject")}</p> : null}
        </div>
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
