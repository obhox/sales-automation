import Link from "next/link";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlarmClock, Ban, CalendarClock, ChevronDown, CircleCheck, CircleDot, Clock, Ellipsis, ExternalLink, Eye, Flame, Lock, MailOpen, Plane, RotateCcw, Tag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Avatar, ChannelBadge, IconButton, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, Pill, TextAction, type Icon } from "@/components/ui";
import { cn } from "@/lib/client/cn";
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
  const c = detail.conversation;
  const verdict = verdictOf(c.verdict);
  const temperature = temperatureOf(c.temperature);
  const due = dueLabel(c.sla_due_at, c.status);
  const role = [c.title, c.company].filter(Boolean).join(" · ");
  const latest = detail.latest_reply;

  return (
    <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-2.5 border-b border-line px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={c.name} size={34} tint="bg-li-tint" className="text-125 text-li" />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex min-w-0 items-center gap-[7px]">
            <h2 className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{c.name}</h2>
            <Pill tone={verdict.tone} icon={VERDICT_ICON[verdict.key]} className="h-[18px] px-[7px] text-10">{verdict.label}</Pill>
            <Menu
              align="start" width={190}
              trigger={
                <button type="button" disabled={!canEdit} aria-label={`Sentiment: ${temperature?.label ?? "not set"}. Change`} className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-control px-[7px] text-10 font-semibold text-ink-2 hover:text-ink disabled:pointer-events-none">
                  <Flame size={10} aria-hidden="true" />{temperature?.label ?? "Sentiment"}
                </button>
              }
            >
              <MenuLabel>Sentiment</MenuLabel>
              {TEMPERATURES.map((item) => <MenuChoice key={item.key} checked={c.temperature === item.key} onSelect={() => actions.patch({ temperature: item.key })}>{item.label}</MenuChoice>)}
              <MenuSeparator />
              <MenuItem onSelect={() => actions.patch({ temperature: null })}>Follow the verdict</MenuItem>
            </Menu>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {role ? <span className="truncate text-11 text-ink-2">{role}</span> : c.email ? <span className="truncate text-11 text-ink-2">{c.email}</span> : null}
            {c.linkedin_url ? (
              <a href={c.linkedin_url} target="_blank" rel="noreferrer" aria-label="Open their LinkedIn profile" title="Open their LinkedIn profile" className="shrink-0 rounded"><ChannelBadge channel="linkedin" size={18} className="rounded" /></a>
            ) : null}
            {c.email ? <span title={c.email} className="shrink-0"><ChannelBadge channel="email" size={18} className="rounded" /></span> : null}
            {c.intent_score ? <span className={cn("shrink-0 text-105 font-semibold", c.intent_score >= 70 ? "text-good" : c.intent_score >= 40 ? "text-warn" : "text-ink-3")}>Intent {Math.round(c.intent_score)}</span> : null}
            {c.status === "open" ? (
              <Menu
                align="start" width={200}
                trigger={
                  <button type="button" disabled={!canEdit} className={cn("inline-flex shrink-0 items-center gap-1 text-105 font-semibold hover:underline disabled:pointer-events-none", due?.overdue ? "text-bad" : "text-ink-3")}>
                    <CalendarClock size={11} aria-hidden="true" />{due?.text ?? "No answer due"}
                  </button>
                }
              >
                <MenuLabel>Answer due</MenuLabel>
                {DUE_CHOICES.map((choice) => <MenuItem key={choice.key} onSelect={() => actions.patch({ sla_due_at: hoursFromNow(choice.hours) })}>{choice.label}</MenuItem>)}
                <MenuSeparator />
                <MenuItem onSelect={() => actions.patch({ sla_due_at: null })}>No answer due</MenuItem>
              </Menu>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {c.target_id ? (
          <Link href={`/contacts/${c.target_id}`} aria-label="Open the contact" title="Open the contact" className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-control hover:text-ink">
            <ExternalLink size={15} aria-hidden="true" />
          </Link>
        ) : null}
        <IconButton icon={MailOpen} label="Mark as unread" size={28} onClick={() => actions.patch({ read: false }, "Marked as unread")} />
        {canEdit ? (
          <>
            {c.status === "closed"
              ? <IconButton icon={RotateCcw} label="Open the conversation again" size={28} onClick={() => actions.patch({ status: "open" }, "Opened again")} />
              : <IconButton icon={CircleCheck} label="Close the conversation" size={28} onClick={() => actions.patch({ status: "closed" }, "Closed")} />}
            <Menu trigger={<IconButton icon={Ellipsis} label="More for this conversation" size={28} />} width={236}>
              <MenuLabel>Verdict on the latest reply</MenuLabel>
              {meta?.capabilities.classify ? <MenuItem icon={RotateCcw} disabled={!latest} onSelect={() => actions.reclassify()}>Read it again</MenuItem> : null}
              {VERDICTS.map((item) => (
                <MenuItem key={item.key} icon={VERDICT_ICON[item.key]} disabled={!latest} onSelect={() => actions.reclassify(item.key)}>Mark as {item.label.toLowerCase()}</MenuItem>
              ))}
              <MenuSeparator />
              {detail.followup ? <MenuItem icon={Ban} onSelect={actions.cancelFollowup}>Cancel the follow-up</MenuItem> : null}
              {c.detached ? <MenuItem onSelect={actions.openRelink}>Link to a contact…</MenuItem> : null}
              {detail.answer.linkedin.can ? <MenuItem onSelect={actions.readLinkedin}>Read their LinkedIn replies now</MenuItem> : null}
              <MenuItem icon={Tag} onSelect={actions.openTags}>Manage tags…</MenuItem>
              <MenuItem onSelect={actions.openSavedReplies}>Manage saved replies…</MenuItem>
            </Menu>
          </>
        ) : null}
      </div>
    </header>
  );
}

/** Who has it, where it stands, what it is filed under, and putting it off until later. */
export function TriageBar({ detail, meta, me, role, canEdit, actions }: { detail: ConversationDetail; meta: InboxMeta | undefined; me: string | null; role: string; canEdit: boolean; actions: ThreadActions }) {
  const c = detail.conversation;
  const status = STATUSES.find((item) => item.key === c.status) ?? STATUSES[0];
  const tagged = new Set(c.tags.map((tag) => tag.id));
  const lockedByOther = c.lock && c.lock.user_id !== me ? c.lock : null;
  const statusTone = c.status === "open" ? "border-good bg-good-tint text-good font-semibold" : c.status === "snoozed" ? "border-warn bg-warn-tint text-warn font-semibold" : "border-line-strong bg-control text-ink-2 font-semibold";

  return (
    <div className="flex min-h-[45px] shrink-0 flex-wrap items-center justify-between gap-x-[7px] gap-y-1.5 border-b border-line bg-subtle px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-[7px]">
        <Menu
          align="start" width={220}
          trigger={
            <Control disabled={!canEdit} className="px-2" aria-label={`Assigned to ${c.assignee?.name ?? "nobody"}. Change`}>
              {c.assignee ? <Avatar name={c.assignee.name} size={18} tint="bg-brand-tint" className="text-brand-strong" /> : null}
              <span className="max-w-[120px] truncate">{c.assignee?.name ?? "Unassigned"}</span>
            </Control>
          }
        >
          {me && c.assignee?.id !== me ? <MenuItem onSelect={() => actions.patch({ assigned_to: me }, "Assigned to you")}>Assign to me</MenuItem> : null}
          <MenuChoice checked={!c.assignee} onSelect={() => actions.patch({ assigned_to: null })}>Unassigned</MenuChoice>
          <MenuSeparator />
          {(meta?.members ?? []).filter((member) => member.role !== "viewer").map((member) => (
            <MenuChoice key={member.id} checked={c.assignee?.id === member.id} onSelect={() => actions.patch({ assigned_to: member.id })}>{member.name}</MenuChoice>
          ))}
        </Menu>

        <Menu
          align="start" width={170}
          trigger={<Control disabled={!canEdit} tone={statusTone} aria-label={`Status: ${status.label}. Change`}>{c.status === "open" ? <CircleDot size={13} aria-hidden="true" /> : c.status === "snoozed" ? <Clock size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}{status.label}</Control>}
        >
          <MenuChoice checked={c.status === "open"} onSelect={() => actions.patch({ status: "open" })}>Open</MenuChoice>
          <MenuChoice checked={c.status === "closed"} onSelect={() => actions.patch({ status: "closed" })}>Closed</MenuChoice>
        </Menu>

        <Menu
          align="start" width={220}
          trigger={
            <Control disabled={!canEdit} aria-label="Tags">
              <Tag size={13} className="text-ink-2" aria-hidden="true" />
              <span className="max-w-[110px] truncate">{c.tags[0]?.name ?? "Add tag"}</span>
              {c.tags.length > 1 ? <span className="text-105 font-semibold text-ink-3">+{c.tags.length - 1}</span> : null}
            </Control>
          }
        >
          {(meta?.tags ?? []).length === 0 ? <div className="px-2 py-1.5 text-11 text-ink-3">No tags yet.</div> : null}
          {(meta?.tags ?? []).map((tag) => (
            <MenuCheckItem key={tag.id} checked={tagged.has(tag.id)} onChange={(checked) => actions.patch(checked ? { add_tags: [tag.id] } : { remove_tags: [tag.id] })}>
              <span className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ backgroundColor: tag.color }} aria-hidden="true" />{tag.name}
            </MenuCheckItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={actions.openTags}>Manage tags…</MenuItem>
        </Menu>

        <Menu
          align="start" width={236}
          trigger={<Control disabled={!canEdit}><AlarmClock size={13} className="text-ink-2" aria-hidden="true" />{c.status === "snoozed" ? snoozeLabel(c.snoozed_until).replace("Snoozed until", "Until") : "Snooze"}</Control>}
        >
          <MenuLabel>Bring it back</MenuLabel>
          {snoozeChoices().map((choice) => (
            <MenuItem key={choice.key} onSelect={() => actions.patch({ status: "snoozed", snoozed_until: choice.until() }, "Snoozed")}>
              <span className="flex w-full items-center justify-between gap-3"><span>{choice.label}</span><span className="text-105 text-ink-3">{choice.hint}</span></span>
            </MenuItem>
          ))}
          {c.status === "snoozed" ? (<><MenuSeparator /><MenuItem onSelect={() => actions.patch({ status: "open" }, "Opened again")}>Open it now</MenuItem></>) : null}
        </Menu>
      </div>

      {lockedByOther ? (
        <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-warn-tint px-[9px]" role="status">
          <Lock size={13} className="text-warn" aria-hidden="true" />
          <span className="text-11 font-semibold text-warn">{lockLabel(lockedByOther)}</span>
          {canEdit && (role === "admin" || role === "owner") ? <TextAction className="ml-1 text-warn" onClick={() => actions.patch({ lock: false }, "The lock was lifted")}>Lift</TextAction> : null}
        </div>
      ) : null}
    </div>
  );
}
