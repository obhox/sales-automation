import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, EmptyState, ErrorState, Field, IconButton, Input, LoadingState, Pill, Select, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { ColorDots } from "./ContactDialogs";
import { CONTACT_TAGS_PATH, CUSTOM_FIELDS_PATH, FIELD_TYPE_LABEL, fieldKeyFor, tagTone, type ContactFacets } from "./model";

// ── Tags ──────────────────────────────────────────────────────────────────────

/** Rename, recolour and delete the workspace's contact tags. Members read; a manager changes. */
export function ManageTagsDialog({ open, tags, canManage, onClose, onChanged }: { open: boolean; tags: ContactFacets["tags"]; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("ContactManagement");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("tagsTitle")} description={canManage ? t("tagsChanges") : t("tagsReadOnly")} size="sm">
      {open ? (
        tags.length === 0 ? (
          <EmptyState title={t("noTags")}>{t("noTagsHint")}</EmptyState>
        ) : (
          <ul className="flex flex-col gap-px">
            {tags.map((tag) => <TagRow key={tag.id} tag={tag} canManage={canManage} onChanged={onChanged} />)}
          </ul>
        )
      ) : null}
    </Dialog>
  );
}

function TagRow({ tag, canManage, onChanged }: { tag: ContactFacets["tags"][number]; canManage: boolean; onChanged: () => void }) {
  const t = useTranslations("ContactManagement");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api(CONTACT_TAGS_PATH, { method: "PATCH", body: { id: tag.id, name: name.trim(), color } });
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: t("deleteTagTitle", {name: tag.name}),
      body: tag.count ? t("deleteTagCount", {count: tag.count}) : t("tagNoContacts"),
      confirmLabel: t("deleteTag"), tone: "danger",
    });
    if (!ok) return;
    try {
      await api(CONTACT_TAGS_PATH, { method: "DELETE", query: { id: tag.id } });
      toast.success(t("tagDeleted", {name: tag.name}));
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  if (editing) {
    return (
      <li className="rounded-md bg-subtle p-2">
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} aria-label={t("tagName")} autoFocus frameClassName="flex-1" />
          <ColorDots value={color} onChange={setColor} />
          <IconButton type="submit" icon={Check} label={t("save")} size={28} variant="outline" disabled={busy || !name.trim()} />
          <IconButton icon={X} label={t("cancel")} size={28} onClick={() => { setEditing(false); setName(tag.name); setColor(tag.color); }} />
        </form>
      </li>
    );
  }
  return (
    <li className="flex h-9 items-center justify-between gap-2 rounded-md px-2 hover:bg-subtle">
      <Pill tone={tagTone(tag.color)} className="max-w-[200px] truncate">{tag.name}</Pill>
      <span className="flex items-center gap-1">
        <span className="mr-1 text-105 text-ink-3">{t("tagCount", {count: tag.count})}</span>
        {canManage ? (
          <>
            <IconButton icon={Pencil} label={t("rename", {name: tag.name})} size={24} onClick={() => setEditing(true)} />
            <IconButton icon={Trash2} label={t("delete", {name: tag.name})} size={24} onClick={() => void remove()} />
          </>
        ) : null}
      </span>
    </li>
  );
}

// ── Custom fields ─────────────────────────────────────────────────────────────

interface FieldDefinition {
  id: string;
  name: string;
  key: string;
  field_type: string;
  contacts: number;
}

const TYPE_KEYS: Record<string, "typeText" | "typeNumber" | "typeBoolean" | "typeDate"> = {
  text: "typeText", number: "typeNumber", boolean: "typeBoolean", date: "typeDate",
};

/**
 * The workspace's own contact fields: what they are called, the key campaign wording uses
 * for them, and their type. A manager adds, renames and deletes; everyone else reads.
 */
export function CustomFieldsDialog({ open, canManage, onClose, onChanged }: { open: boolean; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("ContactManagement");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("fieldsTitle")} description={t("fieldsDescription")} size="md">
      {open ? <CustomFields canManage={canManage} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

function CustomFields({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const t = useTranslations("ContactManagement");
  const { data, error, mutate } = useApi<{ fields: FieldDefinition[] }>(CUSTOM_FIELDS_PATH, { view: "manage" });
  const [adding, setAdding] = useState(false);
  const changed = () => { void mutate(); onChanged(); };

  if (error && !data) return <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />;
  if (!data) return <LoadingState label={t("loadingFields")} />;

  return (
    <div className="flex flex-col gap-3.5">
      {data.fields.length === 0 && !adding ? (
        <EmptyState title={t("noFields")}>
          {canManage ? t("noFieldsAdd") : t("noFieldsReadOnly")}
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {data.fields.map((field) => <FieldRow key={field.id} field={field} canManage={canManage} onChanged={changed} />)}
        </ul>
      )}
      {canManage ? (
        adding ? <NewField onDone={() => { setAdding(false); changed(); }} onCancel={() => setAdding(false)} /> : <Button icon={Plus} className="self-start" onClick={() => setAdding(true)}>{t("addField")}</Button>
      ) : null}
      <p className="text-11 leading-4 text-ink-3">
        {t("fieldHint")} <code className="font-mono text-ink-2">{"{{renewal_date|soon}}"}</code>: {t("fieldHintTail")}
      </p>
    </div>
  );
}

function FieldRow({ field, canManage, onChanged }: { field: FieldDefinition; canManage: boolean; onChanged: () => void }) {
  const t = useTranslations("ContactManagement");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(field.name);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api(CUSTOM_FIELDS_PATH, { method: "PATCH", body: { id: field.id, name: name.trim() } });
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: t("deleteFieldTitle", {name: field.name}),
      body: t("deleteFieldBody", {count: field.contacts, key: "{{" + field.key + "}}"}),
      confirmLabel: t("deleteField"), tone: "danger",
    });
    if (!ok) return;
    try {
      await api(CUSTOM_FIELDS_PATH, { method: "DELETE", query: { id: field.id } });
      toast.success(t("fieldDeleted", {name: field.name}));
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <li className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
      {editing ? (
        <form className="flex flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label={t("fieldName")} autoFocus frameClassName="flex-1" />
          <IconButton type="submit" icon={Check} label={t("save")} size={28} variant="outline" disabled={busy || !name.trim()} />
          <IconButton icon={X} label={t("cancel")} size={28} onClick={() => { setEditing(false); setName(field.name); }} />
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-12 font-semibold text-ink">{field.name}</span>
            <span className="truncate font-mono text-105 text-ink-3">{`{{${field.key}}}`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-105 text-ink-3">{field.contacts ? t("fieldOnCount", {count: field.contacts}) : t("noValue")}</span>
            <Pill>{TYPE_KEYS[field.field_type] ? t(TYPE_KEYS[field.field_type]) : field.field_type}</Pill>
            {canManage ? (
              <>
                <IconButton icon={Pencil} label={t("renameField", {name: field.name})} size={24} onClick={() => setEditing(true)} />
                <IconButton icon={Trash2} label={t("deleteFieldAction", {name: field.name})} size={24} onClick={() => void remove()} />
              </>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

function NewField({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations("ContactManagement");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState("text");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveKey = keyTouched ? key : fieldKeyFor(name);
  const keyOk = /^[a-z][a-z0-9_]*$/.test(effectiveKey);

  async function save() {
    if (!name.trim() || !keyOk || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(CUSTOM_FIELDS_PATH, { method: "POST", body: { name: name.trim(), key: effectiveKey, field_type: type } });
      toast.success(t("fieldAdded", {name: name.trim()}));
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 rounded-lg border border-line bg-subtle p-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid grid-cols-[1fr_1fr_128px] gap-2.5">
        <Field label={t("fieldLabelName")}>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("sampleName")} maxLength={60} autoFocus autoComplete="off" />}</Field>
        <Field label={t("fieldKey")} error={effectiveKey && !keyOk ? t("fieldKeyProblem") : undefined}>
          {(id) => <Input id={id} value={effectiveKey} onChange={(event) => { setKeyTouched(true); setKey(event.target.value); }} placeholder="renewal_date" className="font-mono" autoComplete="off" spellCheck={false} invalid={Boolean(effectiveKey) && !keyOk} />}
        </Field>
        <Field label={t("fieldType")}>{(id) => <Select id={id} value={type} onChange={setType} options={Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label: TYPE_KEYS[value] ? t(TYPE_KEYS[value]) : label }))} className="w-full" />}</Field>
      </div>
      <p className="text-105 text-ink-3">{t("fieldImmutable")}</p>
      {error ? <Alert tone="bad" title={error} /> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>{t("cancel")}</Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!name.trim() || !keyOk}>{t("addField")}</Button>
      </div>
    </form>
  );
}
