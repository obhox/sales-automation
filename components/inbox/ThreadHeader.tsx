import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlarmClock, Ban, CalendarClock, ChevronDown, CircleCheck, CircleDot, Clock, Ellipsis, ExternalLink, Eye, Flame, Lock, MailOpen, Plane, RotateCcw, Tag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Avatar, ChannelBadge, IconButton, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, Pill, TextAction, type Icon } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { parseTime } from "@/lib/client/format";
import { MenuChoice } from "./MenuChoice";
import { DUE_CHOICES, STATUSES, TEMPERATURES, VERDICTS, dueLabel, hoursFromNow, lockLabel, snoozeChoices, snoozeLabel, temperatureOf, verdictOf, type ConversationDetail, type InboxMeta } from "./model";

const VERDICT_ICON: Record<string, Icon> = { positive: ThumbsUp, human_review: Eye, out_of_office: Plane, negative: ThumbsDown, unsubscribe: Ban };

export interface ThreadActions {
  /** Change the conversation. `done` is said once it has been. */
  patch: (body: Record<string, unknown>, done?: string) => void;
  /** Read the latest reply again, or set its verdict by hand. */
  reclassify: (verdict?: string) => void;
  cancelFollowup: () => void;
  readLinkedin: () => void;
  openRelink: () => void;
  openTags: () => void;
  openSavedReplies: () => void;
}

/** A control in the triage bar: a white, bordered button that opens a menu. */
const Control = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string; children: ReactNode }>(function Control({ tone, className, children, ...props }, ref) {
  return (
    <button
      ref={ref} type="button"
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-[9px] text-115 font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
        tone ?? "border-line-strong bg-surface text-ink hover:bg-subtle", className,
      )}
      {...props}
    >
      {children}
      <ChevronDown size={12} className="shrink-0 opacity-70" aria-hidden="true" />
    </button>
  );
});

/** Who the conversation is with, how it reads, and the few things done to the whole of it. */
export function ThreadHeader({ detail, meta, canEdit, actions }: { detail: ConversationDetail; meta: InboxMeta | undefined; canEdit: boolean; actions: ThreadActions }) {
  const t = useTranslations("InboxThreadHeader");
  const locale = useLocale();
  const c = detail.conversation;
  const verdict = verdictOf(c.verdict);
  const temperature = temperatureOf(c.temperature);
  const due = dueLabel(c.sla_due_at, c.status);
  const role = [c.title, c.company].filter(Boolean).join(" · ");
  const verdictLabels: Record<string, string> = {
    positive: t("positive"), human_review: t("humanReview"), out_of_office: t("outOfOffice"),
    negative: t("negative"), unsubscribe: t("unsubscribe"),
  };
  const temperatureLabels: Record<string, string> = {hot: t("hot"), warm: t("warm"), cold: t("cold")};
  const latest = detail.latest_reply;

  return (
    <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-2.5 border-b border-line px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={c.name} size={34} tint="bg-li-tint" className="text-125 text-li" />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex min-w-0 items-center gap-[7px]">
            <h2 className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{c.name}</h2>
            <Pill tone={verdict.tone} icon={VERDICT_ICON[verdict.key]} className="h-[18px] px-[7px] text-10">{verdictLabels[verdict.key] ?? verdict.label}</Pill>
            <Menu
              align="start" width={190}
              trigger={
                <button type="button" disabled={!canEdit} aria-label={t("sentimentAria", {value: temperature ? temperatureLabels[temperature.key] ?? temperature.label : t("notSet")})} className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-control px-[7px] text-10 font-semibold text-ink-2 hover:text-ink disabled:pointer-events-none">
                  <Flame size={10} aria-hidden="true" />{temperature ? temperatureLabels[temperature.key] ?? temperature.label : t("sentiment")}
                </button>
              }
            >
              <MenuLabel>{t("sentiment")}</MenuLabel>
              {TEMPERATURES.map((item) => <MenuChoice key={item.key} checked={c.temperature === item.key} onSelect={() => actions.patch({ temperature: item.key })}>{temperatureLabels[item.key] ?? item.label}</MenuChoice>)}
              <MenuSeparator />
              <MenuItem onSelect={() => actions.patch({ temperature: null })}>{t("followVerdict")}</MenuItem>
            </Menu>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {role ? <span className="truncate text-11 text-ink-2">{role}</span> : c.email ? <span className="truncate text-11 text-ink-2">{c.email}</span> : null}
            {c.linkedin_url ? (
              <a href={c.linkedin_url} target="_blank" rel="noreferrer" aria-label={t("openLinkedin")} title={t("openLinkedin")} className="shrink-0 rounded"><ChannelBadge channel="linkedin" size={18} className="rounded" /></a>
            ) : null}
            {c.email ? <span title={c.email} className="shrink-0"><ChannelBadge channel="email" size={18} className="rounded" /></span> : null}
            {c.intent_score ? <span className={cn("shrink-0 text-105 font-semibold", c.intent_score >= 70 ? "text-good" : c.intent_score >= 40 ? "text-warn" : "text-ink-3")}>{t("intent", {score: Math.round(c.intent_score)})}</span> : null}
            {c.status === "open" ? (
              <Menu
                align="start" width={200}
                trigger={
                  <button type="button" disabled={!canEdit} className={cn("inline-flex shrink-0 items-center gap-1 text-105 font-semibold hover:underline disabled:pointer-events-none", due?.overdue ? "text-bad" : "text-ink-3")}>
                    <CalendarClock size={11} aria-hidden="true" />{due ? locale === "pt-BR" ? due.overdue ? t("overdueBy", {duration: due.text.replace(/^Overdue\s+/, "")}) : t("dueIn", {duration: due.text.replace(/^Due in\s+/, "")}) : due.text : t("noDue")}
                  </button>
                }
              >
                <MenuLabel>{t("answerDue")}</MenuLabel>
                {DUE_CHOICES.map((choice) => <MenuItem key={choice.key} onSelect={() => actions.patch({ sla_due_at: hoursFromNow(choice.hours) })}>{choice.key === "1h" ? t("due1h") : choice.key === "4h" ? t("due4h") : t("due24h")}</MenuItem>)}
                <MenuSeparator />
                <MenuItem onSelect={() => actions.patch({ sla_due_at: null })}>{t("noDue")}</MenuItem>
              </Menu>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {c.target_id ? (
          <Link href={`/contacts/${c.target_id}`} aria-label={t("openContact")} title={t("openContact")} className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-control hover:text-ink">
            <ExternalLink size={15} aria-hidden="true" />
          </Link>
        ) : null}
        <IconButton icon={MailOpen} label={t("markUnread")} size={28} onClick={() => actions.patch({ read: false }, t("markedUnread"))} />
        {canEdit ? (
          <>
            {c.status === "closed"
              ? <IconButton icon={RotateCcw} label={t("reopenConversation")} size={28} onClick={() => actions.patch({ status: "open" }, t("openedAgain"))} />
              : <IconButton icon={CircleCheck} label={t("closeConversation")} size={28} onClick={() => actions.patch({ status: "closed" }, t("closedNotice"))} />}
            <Menu trigger={<IconButton icon={Ellipsis} label={t("moreActions")} size={28} />} width={236}>
              <MenuLabel>{t("verdictLatest")}</MenuLabel>
              {meta?.capabilities.classify ? <MenuItem icon={RotateCcw} disabled={!latest} onSelect={() => actions.reclassify()}>{t("readAgain")}</MenuItem> : null}
              {VERDICTS.map((item) => (
                <MenuItem key={item.key} icon={VERDICT_ICON[item.key]} disabled={!latest} onSelect={() => actions.reclassify(item.key)}>{t("markAs", {verdict: (verdictLabels[item.key] ?? item.label).toLowerCase()})}</MenuItem>
              ))}
              <MenuSeparator />
              {detail.followup ? <MenuItem icon={Ban} onSelect={actions.cancelFollowup}>{t("cancelFollowup")}</MenuItem> : null}
              {c.detached ? <MenuItem onSelect={actions.openRelink}>{t("linkToContact")}</MenuItem> : null}
              {detail.answer.linkedin.can ? <MenuItem onSelect={actions.readLinkedin}>{t("readLinkedin")}</MenuItem> : null}
              <MenuItem icon={Tag} onSelect={actions.openTags}>{t("manageTags")}</MenuItem>
              <MenuItem onSelect={actions.openSavedReplies}>{t("manageReplies")}</MenuItem>
            </Menu>
          </>
        ) : null}
      </div>
    </header>
  );
}

/** Who has it, where it stands, what it is filed under, and putting it off until later. */
export function TriageBar({ detail, meta, me, role, canEdit, actions }: { detail: ConversationDetail; meta: InboxMeta | undefined; me: string | null; role: string; canEdit: boolean; actions: ThreadActions }) {
  const t = useTranslations("InboxThreadHeader");
  const locale = useLocale();
  const c = detail.conversation;
  const status = STATUSES.find((item) => item.key === c.status) ?? STATUSES[0];
  const statusLabels: Record<string, string> = {open: t("open"), closed: t("closed"), snoozed: t("snoozed")};
  const tagged = new Set(c.tags.map((tag) => tag.id));
  const lockedByOther = c.lock && c.lock.user_id !== me ? c.lock : null;
  const statusTone = c.status === "open" ? "border-good bg-good-tint text-good font-semibold" : c.status === "snoozed" ? "border-warn bg-warn-tint text-warn font-semibold" : "border-line-strong bg-control text-ink-2 font-semibold";

  return (
    <div className="flex min-h-[45px] shrink-0 flex-wrap items-center justify-between gap-x-[7px] gap-y-1.5 border-b border-line bg-subtle px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-[7px]">
        <Menu
          align="start" width={220}
          trigger={
            <Control disabled={!canEdit} className="px-2" aria-label={t("assignedAria", {name: c.assignee?.name ?? t("nobody")})}>
              {c.assignee ? <Avatar name={c.assignee.name} size={18} tint="bg-brand-tint" className="text-brand-strong" /> : null}
              <span className="max-w-[120px] truncate">{c.assignee?.name ?? t("unassigned")}</span>
            </Control>
          }
        >
          {me && c.assignee?.id !== me ? <MenuItem onSelect={() => actions.patch({ assigned_to: me }, t("assignedToYou"))}>{t("assignToMe")}</MenuItem> : null}
          <MenuChoice checked={!c.assignee} onSelect={() => actions.patch({ assigned_to: null })}>{t("unassigned")}</MenuChoice>
          <MenuSeparator />
          {(meta?.members ?? []).filter((member) => member.role !== "viewer").map((member) => (
            <MenuChoice key={member.id} checked={c.assignee?.id === member.id} onSelect={() => actions.patch({ assigned_to: member.id })}>{member.name}</MenuChoice>
          ))}
        </Menu>

        <Menu
          align="start" width={170}
          trigger={<Control disabled={!canEdit} tone={statusTone} aria-label={t("statusAria", {value: statusLabels[status.key] ?? status.label})}>{c.status === "open" ? <CircleDot size={13} aria-hidden="true" /> : c.status === "snoozed" ? <Clock size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}{statusLabels[status.key] ?? status.label}</Control>}
        >
          <MenuChoice checked={c.status === "open"} onSelect={() => actions.patch({ status: "open" })}>{t("open")}</MenuChoice>
          <MenuChoice checked={c.status === "closed"} onSelect={() => actions.patch({ status: "closed" })}>{t("closed")}</MenuChoice>
        </Menu>

        <Menu
          align="start" width={220}
          trigger={
            <Control disabled={!canEdit} aria-label={t("tags")}>
              <Tag size={13} className="text-ink-2" aria-hidden="true" />
              <span className="max-w-[110px] truncate">{c.tags[0]?.name ?? t("addTag")}</span>
              {c.tags.length > 1 ? <span className="text-105 font-semibold text-ink-3">+{c.tags.length - 1}</span> : null}
            </Control>
          }
        >
          {(meta?.tags ?? []).length === 0 ? <div className="px-2 py-1.5 text-11 text-ink-3">{t("noTags")}</div> : null}
          {(meta?.tags ?? []).map((tag) => (
            <MenuCheckItem key={tag.id} checked={tagged.has(tag.id)} onChange={(checked) => actions.patch(checked ? { add_tags: [tag.id] } : { remove_tags: [tag.id] })}>
              <span className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ backgroundColor: tag.color }} aria-hidden="true" />{tag.name}
            </MenuCheckItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={actions.openTags}>{t("manageTags")}</MenuItem>
        </Menu>

        <Menu
          align="start" width={236}
          trigger={<Control disabled={!canEdit}><AlarmClock size={13} className="text-ink-2" aria-hidden="true" />{c.status === "snoozed"
    ? locale === "pt-BR" ? c.snoozed_until
      ? t("untilDate", {date: (parseTime(c.snoozed_until)?.toLocaleString("pt-BR", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}) ?? "—")})
      : t("untilWrite")
    : snoozeLabel(c.snoozed_until).replace("Snoozed until", "Until")
    : t("snooze")}</Control>}
        >
          <MenuLabel>{t("bringBack")}</MenuLabel>
          {snoozeChoices().map((choice) => (
            <MenuItem key={choice.key} onSelect={() => actions.patch({ status: "snoozed", snoozed_until: choice.until() }, t("snoozedNotice"))}>
              <span className="flex w-full items-center justify-between gap-3"><span>{choice.key === "later" ? t("later") : choice.key === "tomorrow" ? t("tomorrow") : choice.key === "monday" ? t("nextWeek") : t("untilWrite")}</span><span className="text-105 text-ink-3">{locale === "pt-BR" ? choice.until() ? (parseTime(choice.until())?.toLocaleString("pt-BR", {weekday: "short", hour: "2-digit", minute: "2-digit"}) ?? choice.hint) : t("noEndTime") : choice.hint}</span></span>
            </MenuItem>
          ))}
          {c.status === "snoozed" ? (<><MenuSeparator /><MenuItem onSelect={() => actions.patch({ status: "open" }, t("openedAgain"))}>{t("openNow")}</MenuItem></>) : null}
        </Menu>
      </div>

      {lockedByOther ? (
        <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-warn-tint px-[9px]" role="status">
          <Lock size={13} className="text-warn" aria-hidden="true" />
          <span className="text-11 font-semibold text-warn">{locale === "pt-BR" ? t("replyingLock", {name: lockedByOther.name, elapsed: lockLabel(lockedByOther).includes(" · ") ? t("elapsedLock", {time: lockLabel(lockedByOther).split(" · ").pop()!}) : ""}) : lockLabel(lockedByOther)}</span>
          {canEdit && (role === "admin" || role === "owner") ? <TextAction className="ml-1 text-warn" onClick={() => actions.patch({ lock: false }, t("lockLifted"))}>{t("lift")}</TextAction> : null}
        </div>
      ) : null}
    </div>
  );
}
