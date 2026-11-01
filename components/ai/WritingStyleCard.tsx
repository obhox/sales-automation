import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Mail, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Button, Card, Dialog, Field, Input, Segmented, TextAction, Textarea, type Icon } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { CardHead } from "./parts";
import { MAX_EXAMPLES, MAX_EXAMPLE_BODY, MAX_EXAMPLE_TITLE, MAX_PROMPT, PROMPT_TAGS, TONE_OPTIONS, type AiExample, type Draft } from "./model";

type ExampleKind = "email_examples" | "linkedin_examples";

/** How every AI-written message should read: a tone, the standing instructions, and examples to learn from. */
export function WritingStyleCard({ draft, onDraft, canEdit }: { draft: Draft; onDraft: (patch: Partial<Draft>) => void; canEdit: boolean }) {
  const t = useTranslations("AiWritingStyle");
  const prompt = useRef<HTMLTextAreaElement>(null);
  // Open from the start when there is something in it; otherwise it stays out of the way.
  const [extraOpen, setExtraOpen] = useState(draft.user_prompt.trim() !== "");
  const [editing, setEditing] = useState<{ kind: ExampleKind; index: number | null } | null>(null);
  const tone = draft.tone ?? "neutral";
  const toneLabels = {neutral: t("neutral"), direct: t("direct"), warm: t("warm"), formal: t("formal")};
  const toneNotes = {neutral: t("noteNeutral"), direct: t("noteDirect"), warm: t("noteWarm"), formal: t("noteFormal")};
  const over = draft.system_prompt.length > MAX_PROMPT;

  /** Put a tag where the cursor is, and leave the cursor after it. */
  function insertTag(tag: string) {
    const field = prompt.current;
    const start = field?.selectionStart ?? draft.system_prompt.length;
    const end = field?.selectionEnd ?? start;
    onDraft({ system_prompt: `${draft.system_prompt.slice(0, start)}${tag}${draft.system_prompt.slice(end)}` });
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  function saveExample(kind: ExampleKind, index: number | null, example: AiExample | null) {
    const list = [...draft[kind]];
    if (example === null) {
      if (index !== null) list.splice(index, 1);
    } else if (index === null) list.push(example);
    else list[index] = example;
    onDraft({ [kind]: list });
    setEditing(null);
  }

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <CardHead
        title={t("title")}
        subtitle={t("subtitle")}
        aside={
          canEdit ? (
            <Segmented size="sm" label={t("tone")} value={tone} onChange={(value) => onDraft({ tone: value === "neutral" ? null : value })} options={TONE_OPTIONS.map((option) => ({...option, label: toneLabels[option.value]}))} />
          ) : (
            <span className="text-11 font-semibold text-ink-2">{t("toneValue", {name: toneLabels[tone]})}</span>
          )
        }
      />

      <div className="flex flex-col gap-2 rounded-lg bg-subtle p-[11px] focus-within:ring-2 focus-within:ring-brand-tint">
        <textarea
          ref={prompt}
          aria-label={t("writing")}
          value={draft.system_prompt}
          onChange={(event) => onDraft({ system_prompt: event.target.value })}
          readOnly={!canEdit}
          rows={5}
          placeholder={canEdit ? t("placeholder") : t("notSet")}
          className="block w-full resize-y bg-transparent text-125 leading-[19px] text-ink outline-none placeholder:text-ink-3"
        />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {canEdit
              ? PROMPT_TAGS.map((tag) => (
                  <button key={tag} type="button" onClick={() => insertTag(tag)} title={t("insert", {tag})} className="inline-flex h-[19px] items-center rounded-[5px] bg-control px-1.5 font-mono text-10 text-ink-2 hover:bg-line-strong hover:text-ink">
                    {tag}
                  </button>
                ))
              : null}
            <span className="text-105 text-ink-3">{toneNotes[tone]}</span>
          </div>
          <span className={cn("shrink-0 text-105", over ? "font-semibold text-bad" : "text-ink-3")}>
            {t("characters", {count: draft.system_prompt.length, max: MAX_PROMPT})}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <button type="button" aria-expanded={extraOpen} onClick={() => setExtraOpen((open) => !open)} className="inline-flex items-center gap-1 self-start rounded-sm text-11 font-semibold text-ink-2 hover:text-ink">
          {extraOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {t("extra")}
          {!extraOpen && draft.user_prompt.trim() ? <span className="font-normal text-ink-3">· {t("shortCharacters", {count: draft.user_prompt.length})}</span> : null}
        </button>
        {extraOpen ? (
          <Field label={t("extraLabel")} hint={t("extraHint")} error={draft.user_prompt.length > MAX_PROMPT ? t("maxCharacters", {count: MAX_PROMPT}) : undefined}>
            {(id) => <Textarea id={id} tone="sunken" rows={3} value={draft.user_prompt} readOnly={!canEdit} onChange={(event) => onDraft({ user_prompt: event.target.value })} placeholder={canEdit ? t("extraPlaceholder") : t("none")} />}
          </Field>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ExampleList icon={Mail} title={t("emailExamples")} iconClass="text-mail" examples={draft.email_examples} canEdit={canEdit} onAdd={() => setEditing({ kind: "email_examples", index: null })} onEdit={(index) => setEditing({ kind: "email_examples", index })} />
        <ExampleList icon={MessageSquare} title={t("linkedinExamples")} iconClass="text-li" examples={draft.linkedin_examples} canEdit={canEdit} onAdd={() => setEditing({ kind: "linkedin_examples", index: null })} onEdit={(index) => setEditing({ kind: "linkedin_examples", index })} />
      </div>

      {editing ? (
        <ExampleDialog
          key={`${editing.kind}:${editing.index ?? "new"}`}
          channel={editing.kind === "email_examples" ? "email" : "linkedin"}
          example={editing.index === null ? null : draft[editing.kind][editing.index] ?? null}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSave={(example) => saveExample(editing.kind, editing.index, example)}
          onDelete={editing.index === null ? undefined : () => saveExample(editing.kind, editing.index, null)}
        />
      ) : null}
    </Card>
  );
}

function ExampleList({
  icon: IconGlyph, iconClass, title, examples, canEdit, onAdd, onEdit,
}: {
  icon: Icon; iconClass: string; title: string; examples: AiExample[]; canEdit: boolean; onAdd: () => void; onEdit: (index: number) => void;
}) {
  const t = useTranslations("AiWritingStyle");
  const full = examples.length >= MAX_EXAMPLES;
  return (
    <section className="flex min-w-0 flex-col gap-[9px] rounded-[9px] bg-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-[7px]">
          <IconGlyph size={14} className={cn("shrink-0", iconClass)} aria-hidden="true" />
          <h3 className="truncate text-125 font-semibold text-ink">{title}</h3>
          <span className="text-105 font-bold text-ink-3">{examples.length}</span>
        </div>
        {canEdit && !full ? <TextAction onClick={onAdd}>{t("add")}</TextAction> : null}
      </div>
      {examples.length === 0 ? (
        <p className="py-1 text-11 leading-4 text-ink-3">{canEdit ? t("emptyHint") : t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-[9px]">
          {examples.map((example, index) => (
            <li key={index}>
              <button type="button" onClick={() => onEdit(index)} className="group flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-[9px] py-[7px] text-left transition-colors hover:border-line-strong">
                <span className="min-w-0 flex-1 truncate text-12 text-ink">{example.title || (example.body.trim() ? firstLine(example.body) : t("untitled"))}</span>
                {canEdit ? <Pencil size={12} className="shrink-0 text-ink-3 group-hover:text-ink-2" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {canEdit && full ? <p className="text-105 text-ink-3">{t("limit", {count: MAX_EXAMPLES})}</p> : null}
    </section>
  );
}

const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80) || "Untitled example";

function ExampleDialog({
  channel, example, canEdit, onClose, onSave, onDelete,
}: {
  channel: "email" | "linkedin"; example: AiExample | null; canEdit: boolean; onClose: () => void; onSave: (example: AiExample) => void; onDelete?: () => void;
}) {
  const t = useTranslations("AiWritingStyle");
  const [title, setTitle] = useState(example?.title ?? "");
  const [body, setBody] = useState(example?.body ?? "");
  const [tried, setTried] = useState(false);
  const missing = body.trim() === "";
  const tooLong = body.length > MAX_EXAMPLE_BODY;
  const noun = t(channel === "email" ? "nounEmail" : "nounLinkedin");

  function save() {
    setTried(true);
    if (missing || tooLong) return;
    onSave({ title: title.trim(), body: body.trim() });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      icon={channel === "email" ? Mail : MessageSquare}
      title={!canEdit ? t("viewExample", {name: noun}) : example ? t("editExample", {name: noun}) : t("addExample", {name: noun})}
      description={t("dialogHelp")}
      footer={
        canEdit ? (
          <>
            {onDelete ? <Button variant="danger" icon={Trash2} onClick={onDelete}>{t("remove")}</Button> : <span />}
            <div className="flex items-center gap-2">
              <Button onClick={onClose}>{t("cancel")}</Button>
              <Button variant="primary" onClick={save}>{example ? t("done") : t("addAction")}</Button>
            </div>
          </>
        ) : (
          <>
            <span />
            <Button onClick={onClose}>{t("close")}</Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label={t("exampleTitle")} hint={t("titleHint")} aside={`${title.length} / ${MAX_EXAMPLE_TITLE}`}>
          {(id) => <Input id={id} data-autofocus value={title} readOnly={!canEdit} maxLength={MAX_EXAMPLE_TITLE} placeholder={channel === "email" ? t("placeholderEmail") : t("placeholderLinkedin")} onChange={(event) => setTitle(event.target.value)} />}
        </Field>
        <Field
          label={channel === "email" ? t("emailSubject") : t("message")}
          error={tried && missing ? t("missing") : tooLong ? t("maxCharacters", {count: MAX_EXAMPLE_BODY}) : undefined}
          aside={`${body.length.toLocaleString("en-US")} / ${MAX_EXAMPLE_BODY.toLocaleString("en-US")}`}
          hint={t("pasteHint")}
        >
          {(id) => <Textarea id={id} rows={10} value={body} readOnly={!canEdit} invalid={(tried && missing) || tooLong} onChange={(event) => setBody(event.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
