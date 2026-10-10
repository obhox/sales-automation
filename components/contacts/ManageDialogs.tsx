import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, EmptyState, ErrorState, Field, IconButton, Input, LoadingState, Pill, Select, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { ColorDots } from "./ContactDialogs";
import { CONTACT_TAGS_PATH, CUSTOM_FIELDS_PATH, FIELD_TYPE_LABEL, contactsNoun, fieldKeyFor, tagTone, type ContactFacets } from "./model";

// ── Tags ──────────────────────────────────────────────────────────────────────

/** Rename, recolour and delete the workspace's contact tags. Members read; a manager changes. */
export function ManageTagsDialog({ open, tags, canManage, onClose, onChanged }: { open: boolean; tags: ContactFacets["tags"]; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Contact tags" description={canManage ? "Changes apply to every contact that carries the tag" : "A manager renames and deletes tags"} size="sm">
      {open ? (
        tags.length === 0 ? (
          <EmptyState title="No tags yet">Select contacts and choose Tag to make the first one.</EmptyState>
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
      title: `Delete the tag "${tag.name}"?`,
      body: tag.count ? `It comes off ${contactsNoun(tag.count)}. The contacts themselves are not changed.` : "No contact carries it.",
      confirmLabel: "Delete tag", tone: "danger",
    });
    if (!ok) return;
    try {
      await api(CONTACT_TAGS_PATH, { method: "DELETE", query: { id: tag.id } });
      toast.success(`Tag "${tag.name}" deleted`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  if (editing) {
    return (
      <li className="rounded-md bg-subtle p-2">
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} aria-label="Tag name" autoFocus frameClassName="flex-1" />
          <ColorDots value={color} onChange={setColor} />
          <IconButton type="submit" icon={Check} label="Save" size={28} variant="outline" disabled={busy || !name.trim()} />
          <IconButton icon={X} label="Cancel" size={28} onClick={() => { setEditing(false); setName(tag.name); setColor(tag.color); }} />
        </form>
      </li>
    );
  }
  return (
    <li className="flex h-9 items-center justify-between gap-2 rounded-md px-2 hover:bg-subtle">
      <Pill tone={tagTone(tag.color)} className="max-w-[200px] truncate">{tag.name}</Pill>
      <span className="flex items-center gap-1">
        <span className="mr-1 text-105 text-ink-3">{contactsNoun(tag.count)}</span>
        {canManage ? (
          <>
            <IconButton icon={Pencil} label={`Rename ${tag.name}`} size={24} onClick={() => setEditing(true)} />
            <IconButton icon={Trash2} label={`Delete ${tag.name}`} size={24} onClick={() => void remove()} />
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

const TYPE_OPTIONS = Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }));

/**
 * The workspace's own contact fields: what they are called, the key campaign wording uses
 * for them, and their type. A manager adds, renames and deletes; everyone else reads.
 */
export function CustomFieldsDialog({ open, canManage, onClose, onChanged }: { open: boolean; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Custom fields" description="Your own fields on a contact, filled in on the profile or by a CSV import" size="md">
      {open ? <CustomFields canManage={canManage} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

function CustomFields({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const { data, error, mutate } = useApi<{ fields: FieldDefinition[] }>(CUSTOM_FIELDS_PATH, { view: "manage" });
  const [adding, setAdding] = useState(false);
  const changed = () => { void mutate(); onChanged(); };

  if (error && !data) return <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />;
  if (!data) return <LoadingState label="Loading fields" />;

  return (
    <div className="flex flex-col gap-3.5">
      {data.fields.length === 0 && !adding ? (
        <EmptyState title="No custom fields yet">
          {canManage ? "Add a field for anything Linki does not already keep: a renewal date, a plan, a segment." : "A manager adds fields for anything Linki does not already keep."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {data.fields.map((field) => <FieldRow key={field.id} field={field} canManage={canManage} onChanged={changed} />)}
        </ul>
      )}
      {canManage ? (
        adding ? <NewField onDone={() => { setAdding(false); changed(); }} onCancel={() => setAdding(false)} /> : <Button icon={Plus} className="self-start" onClick={() => setAdding(true)}>Add field</Button>
      ) : null}
      <p className="text-11 leading-4 text-ink-3">
        A field can be written into campaign wording by its key, for example <code className="font-mono text-ink-2">{"{{renewal_date|soon}}"}</code>: the text after the bar is used for a contact with no value.
      </p>
    </div>
  );
}

function FieldRow({ field, canManage, onChanged }: { field: FieldDefinition; canManage: boolean; onChanged: () => void }) {
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
      title: `Delete the field "${field.name}"?`,
      body: `${field.contacts ? `${contactsNoun(field.contacts)} ${field.contacts === 1 ? "has" : "have"} a value for it, which is deleted too. ` : ""}Campaign wording that uses {{${field.key}}} will fall back to its default text, or leave a gap if it has none. This cannot be undone.`,
      confirmLabel: "Delete field", tone: "danger",
    });
    if (!ok) return;
    try {
      await api(CUSTOM_FIELDS_PATH, { method: "DELETE", query: { id: field.id } });
      toast.success(`Field "${field.name}" deleted`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <li className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
      {editing ? (
        <form className="flex flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label="Field name" autoFocus frameClassName="flex-1" />
          <IconButton type="submit" icon={Check} label="Save" size={28} variant="outline" disabled={busy || !name.trim()} />
          <IconButton icon={X} label="Cancel" size={28} onClick={() => { setEditing(false); setName(field.name); }} />
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-12 font-semibold text-ink">{field.name}</span>
            <span className="truncate font-mono text-105 text-ink-3">{`{{${field.key}}}`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-105 text-ink-3">{field.contacts ? `On ${contactsNoun(field.contacts)}` : "Not filled in yet"}</span>
            <Pill>{FIELD_TYPE_LABEL[field.field_type] ?? field.field_type}</Pill>
            {canManage ? (
              <>
                <IconButton icon={Pencil} label={`Rename ${field.name}`} size={24} onClick={() => setEditing(true)} />
                <IconButton icon={Trash2} label={`Delete ${field.name}`} size={24} onClick={() => void remove()} />
              </>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

function NewField({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
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
      toast.success(`Field "${name.trim()}" added`);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 rounded-lg border border-line bg-subtle p-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid grid-cols-[1fr_1fr_128px] gap-2.5">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="Renewal date" maxLength={60} autoFocus autoComplete="off" />}</Field>
        <Field label="Key" error={effectiveKey && !keyOk ? "Lower-case letters, digits and underscores, starting with a letter" : undefined}>
          {(id) => <Input id={id} value={effectiveKey} onChange={(event) => { setKeyTouched(true); setKey(event.target.value); }} placeholder="renewal_date" className="font-mono" autoComplete="off" spellCheck={false} invalid={Boolean(effectiveKey) && !keyOk} />}
        </Field>
        <Field label="Type">{(id) => <Select id={id} value={type} onChange={setType} options={TYPE_OPTIONS} className="w-full" />}</Field>
      </div>
      <p className="text-105 text-ink-3">The key and the type cannot be changed afterwards.</p>
      {error ? <Alert tone="bad" title={error} /> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!name.trim() || !keyOk}>Add field</Button>
      </div>
    </form>
  );
}
