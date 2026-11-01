import { useState } from "react";
import {useTranslations} from "next-intl";
import Link from "next/link";
import { ArrowRightLeft, CalendarDays, CircleCheck, CircleX, Handshake, History, ListTodo, Mail, PenLine, Phone, StickyNote, Trash2, Trophy } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Pagination, Segmented, Skeleton, TONE_TINT, TextAction, Textarea, type Icon } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { useTableState } from "@/lib/client/table-state";
import { logActivity } from "./api";
import { RecordSearch, type Picked } from "./RecordSearch";
import { ACTIVITY_GROUPS, ACTIVITY_PATH, LOG_TYPES, activityLine, type ActivityData, type ActivityIcon, type ActivityItem, type LogType } from "./model";

const ICON: Record<ActivityIcon, Icon> = {
  call: Phone, note: StickyNote, email: Mail, meeting: CalendarDays, deal: Handshake, moved: ArrowRightLeft, won: Trophy, lost: CircleX, deleted: Trash2, task: ListTodo, done: CircleCheck,
};

/** The owner filter as "who did it". What nobody owns has no author to filter by. */
const actorOf = (owner: string) => (owner === "all" || owner === "none" ? undefined : owner);

function Line({ item, roomy }: { item: ActivityItem; roomy?: boolean }) {
  const line = activityLine(item);
  const Glyph = ICON[line.icon];
  return (
    <li className={cn("flex gap-2.5", roomy ? "px-3.5 py-2.5" : "py-1.5")}>
      <span className={cn("mt-px inline-flex shrink-0 items-center justify-center rounded-full", roomy ? "size-7" : "size-5", TONE_TINT[line.tone])}><Glyph size={roomy ? 13 : 11} aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-ink", roomy ? "text-125 font-medium" : "truncate text-115")}>{line.text}</span>
        {line.detail && roomy ? <span className="line-clamp-2 text-115 leading-[17px] text-ink-2">{line.detail}</span> : null}
        <span className="truncate text-105 text-ink-3">
          {formatRelative(item.at)} · {line.by}
          {roomy && item.contact ? <> · <Link href={recordHref("contact", item.contact.id)} className="hover:underline">{item.contact.name}</Link></> : null}
        </span>
      </div>
    </li>
  );
}

/** The last few things that happened. Sits in the board view's side card, under the meetings. */
export function RecentActivity({ owner, canEdit, onLog, onViewAll }: { owner: string; canEdit: boolean; onLog: () => void; onViewAll: () => void }) {
  const t = useTranslations("PipelineActivity");
  const { data, error, mutate } = useApi<ActivityData>(ACTIVITY_PATH, { limit: 4, actor: actorOf(owner) });
  return (
    <section className="flex flex-col gap-2 border-t border-line p-3.5" aria-label={t("recent")}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-125 font-semibold text-ink">{t("recent")}</h2>
        {canEdit ? <Button size="sm" icon={PenLine} onClick={onLog}>{t("log")}</Button> : null}
      </div>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} className="py-4" />
      ) : !data ? (
        <div className="flex flex-col gap-2.5 py-1" aria-busy="true" aria-label={t("loading")}>{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-7" />)}</div>
      ) : data.items.length === 0 ? (
        <p className="py-2 text-115 text-ink-3">{t("none")}</p>
      ) : (
        <ul className="flex flex-col">{data.items.map((item) => <Line key={item.id} item={item} />)}</ul>
      )}
      {data && data.total > data.items.length ? <TextAction className="self-start" onClick={onViewAll}>{t("viewAll")}</TextAction> : null}
    </section>
  );
}

/** Everything that has happened, with who did it. */
export function ActivityView({ owner, canEdit, onLog }: { owner: string; canEdit: boolean; onLog: () => void }) {
  const t = useTranslations("PipelineActivity");
  const table = useTableState({ pageSize: 25, sort: { key: "at", direction: "desc" }, filters: { group: "all" } });
  const { data, error, mutate } = useApi<ActivityData>(table.ready ? ACTIVITY_PATH : null, { group: table.filters.group === "all" ? undefined : table.filters.group, actor: actorOf(owner), page: table.page, limit: table.pageSize });
  const filtered = table.filters.group !== "all" || Boolean(actorOf(owner));
  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("title")}</h2>
          <p className="text-11 text-ink-3">{t("subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Segmented label={t("kind")} size="sm" value={table.filters.group as (typeof ACTIVITY_GROUPS)[number]["value"]} onChange={(group) => table.set({ filters: { group } })} options={ACTIVITY_GROUPS.map(option => ({...option, label: t(`groups.${option.value}`)}))} />
          {canEdit ? <Button variant="primary" icon={PenLine} onClick={onLog}>{t("log")}</Button> : null}
        </div>
      </div>
      <div className="border-t border-line">
        {error && !data ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : !data ? (
          <ul className="divide-y divide-line" aria-busy="true" aria-label={t("loading")}>{Array.from({ length: 5 }, (_, index) => <li key={index} className="flex items-center gap-3 px-3.5 py-3"><Skeleton className="size-7 rounded-full" /><Skeleton className="h-3 flex-1" /></li>)}</ul>
        ) : data.items.length === 0 ? (
          <EmptyState icon={History} title={filtered ? t("noMatches") : t("none")}>
            {filtered ? t("noMatchHelp") : t("noneHelp")}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">{data.items.map((item) => <Line key={item.id} item={item} roomy />)}</ul>
        )}
      </div>
      {data && data.total > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2">
          <span className="text-11 text-ink-3">{t("entryCount", {count: formatCount(data.total)})}</span>
          <Pagination page={table.page} pageSize={table.pageSize} total={data.total} onPageChange={(page) => table.set({ page })} />
        </div>
      ) : null}
    </Card>
  );
}

/** Write down a note, a call, an email or a meeting with a contact. */
export function LogActivityDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("PipelineActivity");
  const [type, setType] = useState<LogType>("note");
  const [contact, setContact] = useState<Picked | null>(null);
  const [text, setText] = useState("");
  const [missing, setMissing] = useState<"contact" | "text" | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!contact) return setMissing("contact");
    if (!text.trim()) return setMissing("text");
    setMissing(null);
    setBusy(true);
    try {
      await logActivity({ target_id: contact.id, type, body: text.trim() });
      toast.success(type === "note" ? t("savedNote") : t("savedLog"));
      onSaved();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title={t("log")} icon={PenLine}
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("save")}</Button></span></>}
    >
      <div className="flex flex-col gap-3.5">
        <Field label={t("what")}>{() => <div><Segmented label={t("what")} value={type} onChange={setType} options={LOG_TYPES.map(option => ({...option, label: t(`types.${option.value}`)}))} /></div>}</Field>
        <Field label={t("contact")} error={missing === "contact" ? t("contactError") : undefined}>{(id) => <RecordSearch id={id} kind="contact" value={contact} onChange={(picked) => { setContact(picked); setMissing(null); }} />}</Field>
        <Field label={type === "note" ? t("note") : t("whatSaid")} error={missing === "text" ? t("textError") : undefined}>
          {(id) => <Textarea id={id} rows={4} value={text} onChange={(event) => { setText(event.target.value); setMissing(null); }} placeholder={type === "call" ? t("callExample") : t("noteExample")} invalid={missing === "text"} maxLength={8000} />}
        </Field>
      </div>
    </Dialog>
  );
}
