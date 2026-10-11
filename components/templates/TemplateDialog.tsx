import { useState } from "react";
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
      onSaved(template ? `${form.name.trim()} saved` : `${form.name.trim()} added to the library`);
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
      title={readOnly ? form.name : template ? "Edit template" : "New template"}
      description={readOnly ? `${email ? "Email" : "LinkedIn message"}${form.category ? ` · ${form.category}` : ""}` : "Reusable wording a step can send in place of its own"}
      footer={
        readOnly ? (
          <>
            <span className="text-105 text-ink-3">A member can change templates.</span>
            <Button variant="primary" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <span className="text-105 text-ink-3">{offered ? `Used by ${offered}: a change reaches them at their next send.` : "A step picks templates in the sequence builder."}</span>
            <div className="flex items-center gap-2">
              <Button onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>{template ? "Save" : "Add template"}</Button>
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
            <Field label="Name" error={problem?.field === "name" ? problem.message : null}>
              {(id) => <Input id={id} data-autofocus maxLength={200} placeholder="Intro after a funding round" value={form.name} invalid={problem?.field === "name"} onChange={(event) => set({ name: event.target.value })} />}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-105 font-semibold text-ink-2">Channel</span>
              <Segmented<Channel> label="Channel" value={form.channel} onChange={(channel) => set({ channel })} options={[{ value: "linkedin", label: "LinkedIn" }, { value: "email", label: "Email" }]} />
            </div>
          </div>
        )}
        {readOnly ? null : (
          <Field label="Category" aside="Optional" hint="A step can take every template of a category as its pool, and pick one for each contact.">
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
            label="Message" body={form.body} onBody={(body) => set({ body })}
            subject={email ? form.subject : undefined} onSubject={email ? (subject) => set({ subject }) : undefined} subjectPlaceholder="Quick question about {{company}}"
            tags={mergeTags(customFields, { email })} rows={10} disabled={readOnly}
            placeholder={email ? "Hi {{first_name}}," : "Hi {{first_name}}, I saw that {{company}}…"}
          />
          {problem?.field === "subject" || problem?.field === "body" ? <p className="text-105 text-bad" role="alert">{problem.message}</p> : null}
          {!readOnly && !email && template?.channel === "email" && template.subject ? <p className="text-105 text-ink-3">A LinkedIn message has no subject line: this template&apos;s subject is dropped when it is saved.</p> : null}
        </div>
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
