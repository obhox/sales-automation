import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, CalendarPlus, Check, CheckCheck, ChevronDown, Link2, Lock, Mail, MessageSquareText, Paperclip, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton, Input, LinkedinIcon, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, Popover, Segmented, Spinner, TextAction } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatRelative } from "@/lib/client/format";
import { attachFile, discardDraft, patchConversation, removeAttachment, rewriteDraft, saveDraft, sendAnswer, type DraftBody } from "./api";
import { ATTACHMENT_MAX_BYTES, LINKEDIN_MESSAGE_MAX, appendReply, fileSize, insertAt, lockLabel, type ConversationDetail, type InboxMeta } from "./model";

type Channel = "email" | "linkedin";
type SaveState = "idle" | "saving" | "saved" | "failed";

/** How long after the last keystroke a draft is saved, and how often a lock is renewed while typing. */
const AUTOSAVE_MS = 900;
const LOCK_RENEW_MS = 5 * 60_000;

/** A small square tool under the text box. */
const TOOL = "size-[26px]";

/**
 * Where an answer is written and sent: the saved replies, the channel and the account it
 * goes from, the text, files, merge tags, the booking link, and the two ways to send.
 *
 * It is mounted once per conversation (the parent gives it the conversation's id as its
 * key), so everything typed here belongs to that conversation. What is typed is saved as
 * a draft a moment after typing stops, and the conversation is held for this member while
 * they write so two people do not answer at once.
 */
export function Composer({
  detail, meta, me, isAdmin, onSent, onRefresh, onManageSavedReplies, onSetBookingLink,
}: {
  detail: ConversationDetail;
  meta: InboxMeta | undefined;
  me: string | null;
  isAdmin: boolean;
  /** The answer went (or is queued). Carries the conversation as it is now. */
  onSent: (detail: ConversationDetail, how: { channel: Channel; status: "sent" | "queued"; closed: boolean }) => void;
  /** Something about the draft changed on the server (a file was added or removed). */
  onRefresh: () => void;
  onManageSavedReplies: () => void;
  onSetBookingLink: () => void;
}) {
  const id = detail.conversation.id;
  const answer = detail.answer;
  const [channel, setChannel] = useState<Channel>(detail.draft?.channel ?? answer.default_channel);
  const [body, setBody] = useState(detail.draft?.body ?? "");
  const [subject, setSubject] = useState(detail.draft?.subject ?? answer.email.subject);
  const [mailboxId, setMailboxId] = useState<string | null>(detail.draft?.email_account_id ?? answer.email.default_mailbox_id);
  const [accountId, setAccountId] = useState<string | null>(detail.draft?.linkedin_account_id ?? answer.linkedin.default_account_id);
  const [save, setSave] = useState<SaveState>(detail.draft?.body ? "saved" : "idle");
  const [savedAt, setSavedAt] = useState<string | null>(detail.draft?.updated_at ?? null);
  const [sending, setSending] = useState<null | "send" | "close" | "snooze">(null);
  const [attaching, setAttaching] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [link, setLink] = useState({ open: false, text: "", url: "" });
  const [, tick] = useState(0);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const holdsLock = useRef(false);
  const latest = useRef<DraftBody>({ channel, body, subject, email_account_id: mailboxId, linkedin_account_id: accountId });
  latest.current = { channel, body, subject: channel === "email" ? subject : null, email_account_id: mailboxId, linkedin_account_id: accountId };

  const files = detail.draft?.attachments ?? [];
  const lockedBy = detail.conversation.lock && detail.conversation.lock.user_id !== me ? detail.conversation.lock : null;
  const side = channel === "email" ? answer.email : answer.linkedin;
  const mailbox = answer.email.mailboxes.find((item) => item.id === mailboxId) ?? null;
  const account = answer.linkedin.accounts.find((item) => item.id === accountId) ?? null;
  const tooLong = channel === "linkedin" && body.length > LINKEDIN_MESSAGE_MAX;
  const needsSender = channel === "email" ? !mailbox : !account;
  const blocked = lockedBy ? `${lockedBy.name} is answering this conversation.` : !side.can ? side.why_not : needsSender ? (channel === "email" ? "Choose the mailbox to send from." : "Choose the LinkedIn account to send from.") : null;
  const canSend = !blocked && body.trim() !== "" && !tooLong && !sending && (channel === "linkedin" || subject.trim() !== "") && !(channel === "linkedin" && files.length > 0);

  // ── Draft: saved a moment after typing stops, and once more on the way out ────────────
  const flush = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSave("saving");
    try {
      const saved = await saveDraft(id, latest.current);
      setSavedAt(saved.draft?.updated_at ?? null);
      setSave(saved.draft ? "saved" : "idle");
    } catch {
      dirty.current = true;
      setSave("failed");
    }
  }, [id]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [body, subject, channel, mailboxId, accountId, flush]);

  // "Draft saved 8s ago" has to keep counting while nothing else changes.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(timer);
  }, []);

  // ── Lock: taken at the first keystroke, renewed while writing, let go on the way out ──
  const takeLock = useCallback(() => {
    if (holdsLock.current || lockedBy) return;
    holdsLock.current = true;
    patchConversation(id, { lock: true }).catch(() => { holdsLock.current = false; onRefresh(); });
  }, [id, lockedBy, onRefresh]);

  useEffect(() => {
    const timer = setInterval(() => { if (holdsLock.current && latest.current.body.trim()) void patchConversation(id, { lock: true }).catch(() => {}); }, LOCK_RENEW_MS);
    return () => {
      clearInterval(timer);
      if (dirty.current) void saveDraft(id, latest.current).catch(() => {});
      if (holdsLock.current) void patchConversation(id, { lock: false }).catch(() => {});
    };
  }, [id]);

  function edited(change: () => void) {
    change();
    dirty.current = true;
    takeLock();
  }

  /** Put text where the cursor is in the message, and leave the cursor after it. */
  function insert(text: string) {
    const field = textRef.current;
    const next = insertAt(body, field?.selectionStart ?? body.length, field?.selectionEnd ?? body.length, text);
    edited(() => setBody(next.text));
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(next.cursor, next.cursor); });
  }

  // ── Files ────────────────────────────────────────────────────────────────────────────
  async function onFiles(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    if (fileRef.current) fileRef.current.value = "";
    if (chosen.length === 0) return;
    const tooBig = chosen.find((file) => file.size > ATTACHMENT_MAX_BYTES);
    if (tooBig) return void toast.error(`${tooBig.name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
    setAttaching(true);
    try {
      await flush();
      for (const file of chosen) await attachFile(id, file);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setAttaching(false);
      onRefresh();
    }
  }

  async function removeFile(attachmentId: string) {
    try { await removeAttachment(attachmentId); } catch (cause) { toast.error(errorMessage(cause)); }
    onRefresh();
  }

  // ── Sending ──────────────────────────────────────────────────────────────────────────
  async function send(how: "send" | "close" | "snooze") {
    if (!canSend) return;
    setSending(how);
    try {
      dirty.current = false;
      const result = await sendAnswer(id, { ...latest.current, close: how === "close" });
      holdsLock.current = false;
      let after: ConversationDetail = result;
      if (how === "snooze") after = await patchConversation(id, { status: "snoozed" });
      setBody(""); setSave("idle"); setSavedAt(null);
      onSent(after, { channel: result.sent.channel, status: result.sent.status, closed: how === "close" });
    } catch (cause) {
      dirty.current = true;
      toast.error(errorMessage(cause));
      onRefresh();
    } finally {
      setSending(null);
    }
  }

  async function discard() {
    dirty.current = false;
    setBody(""); setSubject(answer.email.subject); setSave("idle"); setSavedAt(null);
    try { await discardDraft(id); } catch { /* nothing was kept, or it will be overwritten by the next save */ }
    if (holdsLock.current) { holdsLock.current = false; void patchConversation(id, { lock: false }).catch(() => {}); }
    onRefresh();
  }

  async function rewrite() {
    const route = meta?.capabilities.rewrite_route;
    if (!route || !body.trim()) return;
    const before = body;
    setRewriting(true);
    try {
      const text = await rewriteDraft(route, { text: body, channel, target_id: detail.conversation.target_id });
      edited(() => setBody(text));
      toast.success("Rewritten", { action: { label: "Undo", onClick: () => edited(() => setBody(before)) } });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setRewriting(false);
    }
  }

  const groups = useMemo(() => {
    const tags = meta?.merge_tags ?? [];
    return [...new Set(tags.map((tag) => tag.group))].map((group) => ({ group, tags: tags.filter((tag) => tag.group === group) }));
  }, [meta?.merge_tags]);
  const savedReplies = meta?.saved_replies ?? [];
  const shownReplies = savedReplies.slice(0, 3);

  return (
    <>
      <div className="flex min-h-[41px] shrink-0 items-center gap-[7px] overflow-hidden border-t border-line px-3.5 py-2">
        <MessageSquareText size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
        <span className="shrink-0 text-105 font-semibold tracking-[0.3px] text-ink-3">Saved replies</span>
        {shownReplies.map((reply) => (
          <button key={reply.id} type="button" title={reply.body} onClick={() => edited(() => setBody(appendReply(body, reply.body)))} className="inline-flex h-6 min-w-0 shrink items-center rounded-md border border-line bg-subtle px-[9px] text-11 font-medium text-ink-2 hover:border-line-strong hover:text-ink">
            <span className="truncate">{reply.name}</span>
          </button>
        ))}
        {savedReplies.length > shownReplies.length ? (
          <Menu align="end" side="top" width={260} trigger={<button type="button" className="shrink-0 text-11 font-semibold text-brand-strong hover:underline" aria-label={`${savedReplies.length - shownReplies.length} more saved replies`}>+{savedReplies.length - shownReplies.length}</button>}>
            {savedReplies.slice(shownReplies.length).map((reply) => <MenuItem key={reply.id} onSelect={() => edited(() => setBody(appendReply(body, reply.body)))}>{reply.name}</MenuItem>)}
            <MenuSeparator />
            <MenuItem onSelect={onManageSavedReplies}>Manage saved replies…</MenuItem>
          </Menu>
        ) : (
          <TextAction className="shrink-0" onClick={onManageSavedReplies}>{savedReplies.length === 0 ? "Add one" : "Manage"}</TextAction>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-[9px] border-t border-line bg-subtle p-3.5">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
          <Segmented
            label="Answer by" size="sm" value={channel} onChange={(next) => edited(() => setChannel(next))} className="h-[26px] rounded-md"
            options={[{ value: "email", label: "Email", icon: Mail }, { value: "linkedin", label: "LinkedIn", icon: LinkedinIcon }]}
          />
          <span className="flex min-w-0 items-center gap-[5px] text-105 text-ink-3" aria-live="polite">
            {save === "saving" ? <><Spinner size={11} label="Saving the draft" />Saving…</>
              : save === "failed" ? <span className="text-bad">The draft could not be saved</span>
              : save === "saved" && savedAt ? <><Check size={11} aria-hidden="true" /><span className="truncate">Draft saved {formatRelative(savedAt)}</span><button type="button" onClick={discard} className="font-semibold text-ink-2 hover:underline">Discard</button></>
              : null}
          </span>
          <Menu
            align="end" width={260}
            trigger={
              <button type="button" className="inline-flex min-w-0 shrink-0 items-center gap-[5px] rounded text-105 hover:underline" aria-label="Choose what it is sent from">
                <span className="text-ink-3">Sending as</span>
                <span className="max-w-[170px] truncate font-semibold text-ink-2">{channel === "email" ? mailbox?.from_email ?? "Choose a mailbox" : account?.name ?? "Choose an account"}</span>
                <ChevronDown size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
              </button>
            }
          >
            <MenuLabel>{channel === "email" ? "Mailbox" : "LinkedIn account"}</MenuLabel>
            {channel === "email"
              ? answer.email.mailboxes.length === 0 ? <div className="px-2 py-1.5 text-11 text-ink-3">No mailbox is connected.</div>
                : answer.email.mailboxes.map((item) => <MenuCheckItem key={item.id} checked={item.id === mailboxId} onChange={() => edited(() => setMailboxId(item.id))}>{item.name} · {item.from_email}</MenuCheckItem>)
              : answer.linkedin.accounts.length === 0 ? <div className="px-2 py-1.5 text-11 text-ink-3">No LinkedIn account is signed in.</div>
                : answer.linkedin.accounts.map((item) => <MenuCheckItem key={item.id} checked={item.id === accountId} onChange={() => edited(() => setAccountId(item.id))}>{item.name}</MenuCheckItem>)}
          </Menu>
        </div>

        <div className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-surface focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-tint", tooLong ? "border-bad" : "border-line-strong")}>
          {channel === "email" ? (
            <label className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2.5">
              <span className="shrink-0 text-105 font-semibold text-ink-3">Subject</span>
              <input value={subject} onChange={(event) => edited(() => setSubject(event.target.value))} maxLength={300} className="h-full min-w-0 flex-1 bg-transparent text-115 text-ink outline-none placeholder:text-ink-3" placeholder="What the email is about" />
              {answer.email.to ? <span className="max-w-[180px] shrink-0 truncate text-105 text-ink-3">to {answer.email.to}</span> : null}
            </label>
          ) : null}
          <textarea
            ref={textRef} value={body} disabled={Boolean(lockedBy)}
            onChange={(event) => edited(() => setBody(event.target.value))}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send("send"); } }}
            aria-label={channel === "email" ? "Your email" : "Your LinkedIn message"}
            placeholder={channel === "email" ? "Write your answer. ⌘ Enter sends it." : "Write your LinkedIn message. ⌘ Enter sends it."}
            className="h-24 w-full resize-none bg-transparent p-2.5 text-115 leading-[17px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />
          {files.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 border-t border-line p-2" aria-label="Files on this answer">
              {files.map((file) => (
                <li key={file.id} className="inline-flex h-6 max-w-[230px] items-center gap-1.5 rounded-md border border-line bg-subtle pl-2 pr-1 text-11 text-ink-2">
                  <Paperclip size={11} className="shrink-0" aria-hidden="true" /><span className="truncate font-medium">{file.filename}</span><span className="shrink-0 text-ink-3">{fileSize(file.size_bytes)}</span>
                  <button type="button" onClick={() => void removeFile(file.id)} aria-label={`Remove ${file.filename}`} className="inline-flex size-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-control hover:text-ink"><X size={11} aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {blocked || tooLong || (channel === "linkedin" && files.length > 0) ? (
          <p className="flex items-center gap-1.5 text-11 text-warn" role="status">
            {lockedBy ? <Lock size={12} className="shrink-0" aria-hidden="true" /> : null}
            {lockedBy ? `${lockLabel(lockedBy)}. You can send once they are done.`
              : blocked ?? (tooLong ? `A LinkedIn message can be at most ${LINKEDIN_MESSAGE_MAX.toLocaleString("en-US")} characters. This one is ${body.length.toLocaleString("en-US")}.` : "Files cannot be sent on LinkedIn. Remove them, or answer by email.")}
          </p>
        ) : null}

        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-[3px]">
            <input ref={fileRef} type="file" multiple hidden onChange={(event) => void onFiles(event.target.files)} />
            <IconButton icon={Paperclip} label={channel === "linkedin" ? "Files can only go by email" : "Attach a file"} size={24} className={TOOL} disabled={channel === "linkedin" || attaching} onClick={() => fileRef.current?.click()} />
            <Menu align="start" side="top" width={220} trigger={<IconButton icon={Braces} label="Insert a merge tag" size={24} className={TOOL} />}>
              {groups.map(({ group, tags }) => (
                <div key={group}>
                  <MenuLabel>{group}</MenuLabel>
                  {tags.map((tag) => <MenuItem key={tag.tag} onSelect={() => insert(`{{${tag.tag}}}`)}><span className="flex w-full items-center justify-between gap-3"><span>{tag.label}</span><code className="font-mono text-10 text-ink-3">{`{{${tag.tag}}}`}</code></span></MenuItem>)}
                </div>
              ))}
            </Menu>
            <Menu align="start" side="top" width={280} trigger={<IconButton icon={CalendarPlus} label="Meeting link" size={24} className={TOOL} />}>
              <MenuLabel>Meeting link</MenuLabel>
              {meta?.booking_url
                ? <MenuItem onSelect={() => insert(meta.booking_url!)}><span className="truncate">Insert {meta.booking_url.replace(/^https?:\/\//, "")}</span></MenuItem>
                : <div className="px-2 py-1.5 text-11 leading-[15px] text-ink-3">No booking link is set for this workspace{isAdmin ? "." : ". An admin can add one."}</div>}
              {isAdmin ? (<><MenuSeparator /><MenuItem onSelect={onSetBookingLink}>{meta?.booking_url ? "Change the booking link…" : "Set the booking link…"}</MenuItem></>) : null}
            </Menu>
            <Popover
              align="start" side="top" open={link.open} onOpenChange={(open) => setLink((state) => ({ ...state, open }))} className="w-[280px]"
              trigger={<IconButton icon={Link2} label="Insert a link" size={24} className={TOOL} />}
            >
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const url = link.url.trim();
                  if (!/^https?:\/\/\S+$/i.test(url)) return void toast.error("A link starts with https://");
                  insert(link.text.trim() ? `${link.text.trim()} (${url})` : url);
                  setLink({ open: false, text: "", url: "" });
                }}
              >
                <Input aria-label="Address" placeholder="https://" value={link.url} onChange={(event) => setLink((state) => ({ ...state, url: event.target.value }))} autoFocus />
                <Input aria-label="Words for the link" placeholder="Words for the link (optional)" value={link.text} onChange={(event) => setLink((state) => ({ ...state, text: event.target.value }))} />
                <Button type="submit" variant="primary" size="sm" className="self-end">Insert</Button>
              </form>
            </Popover>
            {meta?.capabilities.rewrite ? (
              <Button variant="tint" size="sm" icon={Sparkles} loading={rewriting} disabled={!body.trim()} onClick={() => void rewrite()} className="ml-0.5">Rewrite</Button>
            ) : (
              <Popover align="start" side="top" className="w-[260px]" trigger={<Button variant="tint" size="sm" icon={Sparkles} className="ml-0.5">Rewrite</Button>}>
                <p className="text-115 font-semibold text-ink">Rewriting is not available</p>
                <p className="mt-1 text-11 leading-4 text-ink-2">This workspace has no AI rewriting for answers yet. What you write is sent as you wrote it.</p>
              </Popover>
            )}
            {channel === "linkedin" ? <span className={cn("ml-1.5 text-105 tabular-nums", tooLong ? "font-semibold text-bad" : "text-ink-3")}>{body.length.toLocaleString("en-US")} / {LINKEDIN_MESSAGE_MAX.toLocaleString("en-US")}</span> : null}
            {attaching ? <span className="ml-1.5 inline-flex items-center gap-1 text-105 text-ink-3"><Spinner size={11} label="Adding the file" />Adding…</span> : null}
          </div>
          <div className="flex shrink-0 items-center gap-[7px]">
            <Button icon={CheckCheck} disabled={!canSend} loading={sending === "close"} onClick={() => void send("close")}>Send &amp; close</Button>
            <div className="flex">
              <Button variant="primary" icon={Send} disabled={!canSend} loading={sending === "send" || sending === "snooze"} onClick={() => void send("send")} className="rounded-r-none pr-2.5">Send reply</Button>
              <Menu align="end" side="top" width={250} trigger={<button type="button" disabled={!canSend} aria-label="More ways to send" className="inline-flex h-8 w-7 items-center justify-center rounded-r-md border-l border-white/30 bg-brand text-white hover:bg-brand-strong disabled:pointer-events-none disabled:opacity-50"><ChevronDown size={12} aria-hidden="true" /></button>}>
                <MenuItem onSelect={() => void send("snooze")}>Send and snooze until they write</MenuItem>
                <MenuItem onSelect={() => void send("close")}>Send and close</MenuItem>
              </Menu>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
