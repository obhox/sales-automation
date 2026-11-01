import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, CalendarPlus, Link2, MessageSquareText, Pencil, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Checkbox, Dialog, EmptyState, Field, IconButton, Input, Pill, SearchInput, Spinner, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { createSavedReply, createTag, createView, deleteSavedReply, deleteTag, deleteView, relink, setBookingLink, updateSavedReply, updateTag } from "./api";
import type { InboxMeta, SavedView, ViewState } from "./model";

/** The colours a tag can have: the design's own status and channel colours, and a grey. */
const TAG_COLORS = ["#5e6ad2", "#1f8a5c", "#b4690e", "#c2403a", "#0a66c2", "#0e9384", "#64748b"];

function Swatches({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  const t = useTranslations("InboxDialogs");
  const colorLabels = [t("indigo"), t("green"), t("amber"), t("red"), t("blue"), t("teal"), t("grey")];
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5">
      {TAG_COLORS.map((color, index) => (
        <button
          key={color} type="button" role="radio" aria-checked={value.toLowerCase() === color} aria-label={colorLabels[index]} onClick={() => onChange(color)}
          className={cn("size-[18px] rounded-full border-2 border-surface outline outline-1", value.toLowerCase() === color ? "outline-ink" : "outline-transparent hover:outline-line-strong")}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

/** Make, rename, recolour and delete the tags a conversation can be filed under. */
export function TagManagerDialog({ open, tags, canEdit, onClose, onChanged }: { open: boolean; tags: InboxMeta["tags"]; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("InboxDialogs");
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    try { await work(); done?.(); onChanged(); } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("tags")} description={t("tagsDescription")} icon={Tag} size="sm">
      <div className="flex flex-col gap-3.5">
        {tags.length === 0 ? <p className="text-115 text-ink-2">{t("noTags")}</p> : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {tags.map((tag) => editing?.id === tag.id ? (
              <li key={tag.id} className="flex flex-col gap-2 p-2.5">
                <Input aria-label={t("tagName")} value={editing.name} maxLength={40} onChange={(event) => setEditing({ ...editing, name: event.target.value })} autoFocus />
                <div className="flex items-center justify-between gap-2">
                  <Swatches label={t("tagColor")} value={editing.color} onChange={(next) => setEditing({ ...editing, color: next })} />
                  <span className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("cancel")}</Button>
                    <Button size="sm" variant="primary" loading={busy} disabled={!editing.name.trim()} onClick={() => run(() => updateTag(tag.id, { name: editing.name.trim(), color: editing.color }), () => setEditing(null))}>{t("save")}</Button>
                  </span>
                </div>
              </li>
            ) : (
              <li key={tag.id} className="flex h-10 items-center justify-between gap-2 px-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                  <span className="truncate text-12 font-medium text-ink">{tag.name}</span>
                  <span className="shrink-0 text-105 text-ink-3">{t("conversationCount", {count: tag.conversations})}</span>
                </span>
                {canEdit ? (
                  <span className="flex shrink-0 gap-0.5">
                    <IconButton icon={Pencil} label={t("renameTag", {name: tag.name})} size={24} onClick={() => setEditing({ id: tag.id, name: tag.name, color: tag.color })} />
                    <IconButton
                      icon={Trash2} label={t("deleteTag", {name: tag.name})} size={24}
                      onClick={async () => {
                        const ok = await confirm({ title: t("deleteTagTitle", {name: tag.name}), body: tag.conversations ? t("deleteTagBody", {count: tag.conversations}) : t("noConversations"), confirmLabel: t("deleteTagAction"), tone: "danger" });
                        if (ok) void run(() => deleteTag(tag.id));
                      }}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form className="flex flex-col gap-2 rounded-lg bg-subtle p-2.5" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run(() => createTag(name.trim(), color), () => setName("")); }}>
            <Field label={t("newTag")}>{(id) => <Input id={id} value={name} maxLength={40} placeholder={t("tagPlaceholder")} onChange={(event) => setName(event.target.value)} />}</Field>
            <div className="flex items-center justify-between gap-2">
              <Swatches label={t("newTagColor")} value={color} onChange={setColor} />
              <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!name.trim()}>{t("addTag")}</Button>
            </div>
          </form>
        ) : <p className="text-11 text-ink-3">{t("tagPermission")}</p>}
      </div>
    </Dialog>
  );
}

/** The answers a team sends often, kept once and dropped into a reply with one click. */
export function SavedRepliesDialog({ open, replies, mergeTags, canEdit, onClose, onChanged, onUse }: {
  open: boolean; replies: InboxMeta["saved_replies"]; mergeTags: InboxMeta["merge_tags"]; canEdit: boolean; onClose: () => void; onChanged: () => void; onUse?: (body: string) => void;
}) {
  const t = useTranslations("InboxDialogs");
  const [editing, setEditing] = useState<{ id: string | null; name: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing || !editing.name.trim() || !editing.body.trim()) return;
    setBusy(true);
    try {
      if (editing.id) await updateSavedReply(editing.id, { name: editing.name.trim(), body: editing.body.trim() });
      else await createSavedReply(editing.name.trim(), editing.body.trim());
      setEditing(null);
      onChanged();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open={open} onOpenChange={(next) => { if (!next) { setEditing(null); onClose(); } }} title={t("savedReplies")} icon={MessageSquareText} size="md"
      description={t("savedRepliesDescription")}
      footer={editing ? (
        <><Button variant="ghost" onClick={() => setEditing(null)}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={!editing.name.trim() || !editing.body.trim()} onClick={() => void save()}>{editing.id ? t("saveChanges") : t("saveReply")}</Button></>
      ) : canEdit ? <Button variant="primary" onClick={() => setEditing({ id: null, name: "", body: "" })}>{t("newReply")}</Button> : undefined}
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          <Field label={t("name")} hint={t("nameHint")}>{(id) => <Input id={id} value={editing.name} maxLength={80} placeholder={t("nameExample")} onChange={(event) => setEditing({ ...editing, name: event.target.value })} autoFocus />}</Field>
          <Field label={t("text")} hint={t("mergeTagsHint", {tags: mergeTags.slice(0, 6).map((tag) => `{{${tag.tag}}}`).join(", "), extra: mergeTags.length > 6 ? t("customFieldsExtra") : ""})}>
            {(id) => <Textarea id={id} rows={7} value={editing.body} maxLength={8000} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />}
          </Field>
        </div>
      ) : replies.length === 0 ? (
        <EmptyState icon={MessageSquareText} title={t("noSavedReplies")}>{t("noSavedRepliesBody")}</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {replies.map((reply) => (
            <li key={reply.id} className="flex items-start justify-between gap-3 p-2.5">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-12 font-semibold text-ink">{reply.name}</span>
                <span className="line-clamp-2 whitespace-pre-wrap text-11 leading-4 text-ink-2">{reply.body}</span>
              </div>
              <span className="flex shrink-0 items-center gap-0.5">
                {onUse ? <Button size="sm" onClick={() => { onUse(reply.body); onClose(); }}>{t("use")}</Button> : null}
                {canEdit ? (
                  <>
                    <IconButton icon={Pencil} label={t("editItem", {name: reply.name})} size={24} onClick={() => setEditing({ id: reply.id, name: reply.name, body: reply.body })} />
                    <IconButton
                      icon={Trash2} label={t("deleteItem", {name: reply.name})} size={24}
                      onClick={async () => {
                        const ok = await confirm({ title: t("deleteSavedReplyTitle", {name: reply.name}), body: t("deleteSavedReplyBody"), confirmLabel: t("delete"), tone: "danger" });
                        if (!ok) return;
                        try { await deleteSavedReply(reply.id); onChanged(); } catch (cause) { toast.error(errorMessage(cause)); }
                      }}
                    />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Keep the filters as they are now under a name, and remove views no longer wanted. */
export function SavedViewsDialog({ open, views, current, canShare, hasFilters, onClose, onChanged }: {
  open: boolean; views: SavedView[]; current: ViewState; canShare: boolean; hasFilters: boolean; onClose: () => void; onChanged: (created?: SavedView) => void;
}) {
  const t = useTranslations("InboxDialogs");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const view = await createView(name.trim(), current, shared);
      setName(""); setShared(false);
      onChanged(view);
      toast.success(t("savedViewNotice", {name: view.name}));
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("savedViews")} description={t("savedViewsDescription")} icon={Bookmark} size="sm">
      <div className="flex flex-col gap-3.5">
        <form onSubmit={save} className="flex flex-col gap-2.5 rounded-lg bg-subtle p-2.5">
          <Field label={t("saveAs")} hint={hasFilters ? undefined : t("noFilters")}>
            {(id) => <Input id={id} value={name} maxLength={60} placeholder={t("viewPlaceholder")} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <div className="flex items-center justify-between gap-2">
            {canShare ? (
              <label className="flex items-center gap-2 text-115 text-ink-2"><Checkbox checked={shared} onChange={setShared} />{t("shareWorkspace")}</label>
            ) : <span className="text-11 text-ink-3">{t("onlyYou")}</span>}
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!name.trim()}>{t("saveView")}</Button>
          </div>
        </form>
        {views.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {views.map((view) => (
              <li key={view.id} className="flex h-10 items-center justify-between gap-2 px-2.5">
                <span className="flex min-w-0 items-center gap-2"><Bookmark size={13} className="shrink-0 text-ink-3" aria-hidden="true" /><span className="truncate text-12 font-medium text-ink">{view.name}</span>{view.shared ? <Pill size="sm">{t("shared")}</Pill> : null}</span>
                {view.editable ? (
                  <IconButton
                    icon={Trash2} label={t("deleteItem", {name: view.name})} size={24}
                    onClick={async () => {
                      const ok = await confirm({ title: t("deleteViewTitle", {name: view.name}), body: view.shared ? t("deleteSharedViewBody") : t("deleteViewBody"), confirmLabel: t("deleteViewAction"), tone: "danger" });
                      if (!ok) return;
                      try { await deleteView(view.id); onChanged(); } catch (cause) { toast.error(errorMessage(cause)); }
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

interface Found { kind: string; id: string; title: string; subtitle: string | null }

/** Give a reply whose contact was deleted a contact again: the one with its address, or one chosen here. */
export function RelinkDialog({ open, replyId, address, onClose, onLinked }: { open: boolean; replyId: string | null; address: string | null; onClose: () => void; onLinked: () => void }) {
  const t = useTranslations("InboxDialogs");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      api<{ results: Found[] }>("/api/search", { query: { q: text } })
        .then((found) => { if (!stale) setResults(found.results.filter((result) => result.kind === "contact")); })
        .catch(() => { if (!stale) setResults([]); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [query]);

  async function link(targetId?: string) {
    if (!replyId) return;
    setBusy(true);
    try {
      const result = await relink(replyId, targetId);
      if (!result.relinked) toast.error(address ? t("missingAddress", {address}) : t("noContactMatches"));
      else { toast.success(t("linkedToContact")); onLinked(); onClose(); }
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  const searching = query.trim().length >= 2;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("linkToContact")} icon={Link2} size="sm" description={t("deletedContact")}>
      <div className="flex flex-col gap-3">
        <p className="text-11 leading-4 text-ink-2">{t("linkingInfo")}</p>
        {address?.includes("@") ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-subtle p-2.5">
            <span className="min-w-0 text-115 text-ink-2">{t("useAddress")} <span className="font-semibold text-ink">{address}</span></span>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void link()}>{t("link")}</Button>
          </div>
        ) : null}
        <SearchInput value={query} onChange={setQuery} placeholder={t("searchContact")} />
        {searching && results === null ? <div className="flex items-center gap-2 text-11 text-ink-3"><Spinner size={12} />{t("searching")}</div> : null}
        {searching && results && results.length === 0 ? <p className="text-11 text-ink-3">{t("noMatches")}</p> : null}
        {searching && results && results.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {results.map((result) => (
              <li key={result.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
                <span className="flex min-w-0 flex-col"><span className="truncate text-12 font-medium text-ink">{result.title}</span>{result.subtitle ? <span className="truncate text-105 text-ink-3">{result.subtitle}</span> : null}</span>
                <Button size="sm" disabled={busy} onClick={() => void link(result.id)}>{t("link")}</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The page a contact is sent to to pick a meeting time. One per workspace; an admin sets it. */
export function BookingLinkDialog({ open, url, onClose, onSaved }: { open: boolean; url: string | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("InboxDialogs");
  const [value, setValue] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(url ?? ""); setError(null); } }, [open, url]);

  async function save() {
    setBusy(true);
    try { await setBookingLink(value.trim()); onSaved(); onClose(); toast.success(value.trim() ? t("bookingSaved") : t("bookingRemoved")); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("bookingLink")} icon={CalendarPlus} size="sm"
      description={t("bookingInfo")}
      footer={<><Button variant="ghost" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("save")}</Button></>}
    >
      <Field label={t("address")} error={error} hint={t("bookingAddressHint")}>
        {(id) => <Input id={id} value={value} placeholder="https://cal.com/your-team/intro" invalid={Boolean(error)} onChange={(event) => { setValue(event.target.value); setError(null); }} autoFocus />}
      </Field>
    </Dialog>
  );
}
