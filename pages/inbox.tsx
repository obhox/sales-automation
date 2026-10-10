import Head from "next/head";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  RiMailLine,
  RiLinkedinBoxLine,
  RiSearchLine,
  RiInboxLine,
  RiExternalLinkLine,
  RiSendPlaneLine,
  RiCloseLine,
  RiLoader4Line,
  RiRefreshLine,
} from "react-icons/ri";
import ExportLink from "@/components/ui/ExportLink";
import type { InboxReply } from "./api/inbox/index";
import type { EmailMessage } from "./api/inbox/thread";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const CHANNEL_TABS = [
  { key: "all", label: "All" },
  { key: "email", label: "Email" },
  { key: "linkedin", label: "LinkedIn" },
] as const;

type ChannelFilter = typeof CHANNEL_TABS[number]["key"];

// ── Classifier verdict badges ───────────────────────────────────────────────

const NEUTRAL_BADGE = "bg-base-200 text-base-content/60";

const VERDICT_BADGES: Record<string, { label: string; cls: string }> = {
  positive: { label: "Positive", cls: "bg-success/10 text-success" },
  negative: { label: "Negative", cls: "bg-error/10 text-error" },
  out_of_office: { label: "Out of office", cls: "bg-warning/10 text-warning" },
  unsubscribe: { label: "Unsubscribe", cls: "bg-error/10 text-error" },
  human_review: { label: "Human review", cls: "bg-info/10 text-info" },
  ooo_followup: { label: "OOO follow-up", cls: "bg-warning/10 text-warning" },
  substitute: { label: "Substitute", cls: NEUTRAL_BADGE },
  call_task: { label: "Call task", cls: "bg-success/10 text-success" },
  human_reply: { label: "Human reply", cls: "bg-info/10 text-info" },
  not_interested: { label: "Not interested", cls: "bg-error/10 text-error" },
  cancelled: { label: "Cancelled", cls: "bg-base-200 text-base-content/45" },
};

function verdictBadge(reply: InboxReply): { label: string; cls: string } {
  if (reply.classification_error) return { label: "Failed", cls: "bg-error/10 text-error" };
  if (reply.reply_id && !reply.classified_at) return { label: "Pending", cls: "bg-base-200 text-base-content/45" };
  if (reply.reply_kind && VERDICT_BADGES[reply.reply_kind]) return VERDICT_BADGES[reply.reply_kind];
  return { label: "—", cls: "bg-base-200 text-base-content/40" };
}

// Neutral initials avatar (data-neutral, never chrome accent).
type Team = { members: Array<{ id: string; email: string }>; tags: Array<{ id: string; name: string; color: string }>; saved_replies: Array<{ id: string; name: string; body: string }> };

/** The verdicts a person can set by hand: the ones the classifier itself gives. */
const VERDICT_CHOICES = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "out_of_office", label: "Out of office" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "human_review", label: "Needs review" },
];

/** A stored time as a Date. The database holds UTC with no zone marker; anything with one is taken as written. */
function storedTime(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** What a datetime-local input shows for a stored time, in the viewer's own zone. */
function localInputValue(value: string | null): string {
  const date = storedTime(value);
  if (!date) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** "Due in 3h" or "Overdue 2h", or nothing when no answer is owed any more. */
function slaLabel(dueAt: string | null, status: string | null): { text: string; overdue: boolean } | null {
  const due = storedTime(dueAt);
  if (!due || status === "resolved" || status === "closed") return null;
  const minutes = Math.round((due.getTime() - Date.now()) / 60_000);
  const span = (m: number) => (m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`);
  return minutes < 0 ? { text: `Overdue ${span(-minutes)}`, overdue: true } : { text: `Due in ${span(minutes)}`, overdue: false };
}

/** A tag as a quiet outlined chip; its colour is a dot, not a fill. */
function TagChip({ tag, onRemove }: { tag: { id: string; name: string; color: string }; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-base-content/65">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove tag ${tag.name}`} className="text-base-content/35 hover:text-base-content"><RiCloseLine size={11} /></button>}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable key for filtering — matches the categories the badge renders.
function verdictKey(reply: InboxReply): string {
  if (reply.classification_error) return "failed";
  if (reply.reply_id && !reply.classified_at) return "pending";
  if (reply.reply_kind && VERDICT_BADGES[reply.reply_kind]) return reply.reply_kind;
  return "none";
}

const VERDICT_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All verdicts" },
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "out_of_office", label: "Out of office" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "human_review", label: "Human review" },
  { key: "ooo_followup", label: "OOO follow-up" },
  { key: "substitute", label: "Substitute" },
  { key: "call_task", label: "Call task" },
  { key: "human_reply", label: "Human reply" },
  { key: "not_interested", label: "Not interested" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
  { key: "none", label: "Unclassified" },
];

// ── Reply Modal ───────────────────────────────────────────────────────────────

interface LinkedinMessage { id: string; direction: "in" | "out"; body: string; sent_at: string; status: string; error: string | null; sent_here: number }
interface LinkedinThread {
  messages: LinkedinMessage[];
  account: { id: string; name: string } | null;
  accounts: Array<{ id: string; name: string }>;
  can_reply: boolean; why_not: string | null; last_read_at: string | null; reading: boolean;
}
const NOT_GONE = ["queued", "sending", "failed", "uncertain"];

/** A contact's LinkedIn conversation as stored, with a box to answer in. An answer is queued and sent by the LinkedIn loop, so its state is shown under it until it has gone. */
function LinkedinConversation({ reply, savedReplies }: { reply: InboxReply; savedReplies: Array<{ id: string; name: string; body: string }> }) {
  const [thread, setThread] = useState<LinkedinThread | null>(null);
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/inbox/linkedin-thread?target_id=${encodeURIComponent(reply.id)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not load the conversation");
      setThread(d);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not load the conversation"); }
  }, [reply.id]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  // While something is on its way out, keep looking until it has landed or failed.
  const inFlight = Boolean(thread?.messages.some((m) => m.status === "queued" || m.status === "sending"));
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [inFlight, load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread?.messages.length]);

  async function post(body: Record<string, unknown>, done: string, method = "POST", query = "") {
    setBusy(true);
    try {
      const r = await fetch(`/api/inbox/linkedin-reply${query}`, { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "That did not work");
      toast.success(done);
      await load();
      return true;
    } catch (err) { toast.error(err instanceof Error ? err.message : "That did not work"); return false; }
    finally { setBusy(false); }
  }
  async function send() {
    if (!text.trim()) return;
    if (await post({ target_id: reply.id, text, reply_id: reply.reply_id ?? undefined, account_id: from || thread?.account?.id }, "Queued. It is sent from LinkedIn within a minute.")) setText("");
  }
  async function checkNow() {
    setBusy(true);
    try {
      const r = await fetch("/api/inbox/linkedin-thread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_id: reply.id }) });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "Could not ask for a read");
      toast.success("Reading the LinkedIn inbox. New messages show here in a minute.");
      setTimeout(() => void load(), 45_000);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not ask for a read"); }
    finally { setBusy(false); }
  }

  if (!thread) {
    return <div className="flex flex-1 items-center justify-center gap-2 py-10 text-base-content/30"><RiLoader4Line size={18} className="animate-spin" /><span className="text-sm">Loading conversation…</span></div>;
  }
  const needsAccount = thread.can_reply && !thread.account && thread.accounts.length > 1;
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-2 text-[11px] text-base-content/45">
        <span>
          LinkedIn conversation{thread.account ? ` · ${thread.account.name}` : ""}
          {thread.reading ? (thread.last_read_at ? ` · inbox read ${formatDate(`${thread.last_read_at.replace(" ", "T")}Z`)}` : " · inbox not read yet") : " · reading replies is switched off for this account"}
        </span>
        {thread.account && <button type="button" disabled={busy} onClick={() => void checkNow()} className="shrink-0 underline-offset-2 hover:text-base-content hover:underline disabled:opacity-50">Check for new messages</button>}
      </div>
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        {thread.messages.length === 0 ? (
          <div className="py-10 text-center text-sm text-base-content/30">
            {reply.last_replied_at ? "They are marked as having replied on LinkedIn, but the message has not been read into Linki." : "No LinkedIn messages with this contact have been read yet."}
          </div>
        ) : thread.messages.map((message) => {
          const theirs = message.direction === "in";
          const pending = NOT_GONE.includes(message.status);
          return (
            <div key={message.id} className={`rounded-xl p-3.5 ${theirs ? "bg-base-200 border border-[var(--border-subtle)]" : "bg-base-100 border border-[var(--border)] border-l-2 border-l-primary"} ${pending ? "opacity-80" : ""}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-base-content/70">{theirs ? reply.full_name ?? "Contact" : "You"}</span>
                <span className="text-xs text-base-content/35">{formatDate(message.sent_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-base-content">{message.body}</p>
              {pending && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-2 text-[11px]">
                  {message.status === "queued" && <span className="text-base-content/50">Queued. It is sent from LinkedIn within a minute.</span>}
                  {message.status === "sending" && <span className="inline-flex items-center gap-1 text-base-content/50"><RiLoader4Line size={11} className="animate-spin" /> Sending…</span>}
                  {message.status === "failed" && <span className="text-error">Not sent: {message.error ?? "LinkedIn refused it"}</span>}
                  {message.status === "uncertain" && <span className="text-warning">Not confirmed: {message.error ?? "it may have been delivered"}</span>}
                  {message.status === "failed" && <button type="button" disabled={busy} onClick={() => void post({ retry_id: message.id }, "Queued again")} className="underline-offset-2 hover:underline">Send again</button>}
                  {message.status === "uncertain" && <button type="button" disabled={busy} onClick={() => { if (confirm("Send this message again? Only do this if you have looked at the conversation on LinkedIn and it is not there.")) void post({ retry_id: message.id, confirm: true }, "Queued again"); }} className="underline-offset-2 hover:underline">I checked LinkedIn, send again</button>}
                  {message.status !== "sending" && <button type="button" disabled={busy} onClick={() => void post({}, "Discarded", "DELETE", `?id=${encodeURIComponent(message.id)}`)} className="text-base-content/50 underline-offset-2 hover:underline">Discard</button>}
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {thread.can_reply ? (
        <div className="space-y-2.5 border-t border-[var(--border-subtle)] px-5 py-4">
          {needsAccount && (
            <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="LinkedIn account to send from" className="select select-bordered select-xs w-full">
              <option value="">Send from…</option>
              {thread.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          )}
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={8000}
            placeholder={`Reply to ${reply.full_name ?? "them"} on LinkedIn…`}
            className="w-full resize-none rounded-[10px] border border-[var(--border)] bg-base-100 px-3 py-2 text-sm text-base-content placeholder:text-base-content/35 focus:border-[var(--border-focus)] focus:outline-none"
          />
          {savedReplies.length > 0 && <select className="select select-bordered select-xs w-full" defaultValue="" onChange={(e) => { const saved = savedReplies.find((x) => x.id === e.target.value); if (saved) setText(saved.body); }}><option value="">Insert a saved reply…</option>{savedReplies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-base-content/40">Sent from {thread.account?.name ?? "the account you pick"} on LinkedIn, as a message in this conversation.</span>
            <button onClick={() => void send()} disabled={!text.trim() || busy || (needsAccount && !from)} className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-sm font-semibold text-primary-content transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? <RiLoader4Line size={14} className="animate-spin" /> : <RiSendPlaneLine size={14} />} Send
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-[var(--border-subtle)] px-5 py-3 text-xs text-base-content/45">{thread.why_not}</div>
      )}
    </>
  );
}

interface ReplyModalProps {
  reply: InboxReply;
  onClose: () => void;
  onActionDone: () => void;
  hasPremium: boolean;
  savedReplies: Array<{id:string;name:string;body:string}>;
  team: Team;
  teamAction: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onTeamChanged: () => void;
}

function ReplyModal({ reply, onClose, onActionDone, hasPremium, savedReplies, team, teamAction, onTeamChanged }: ReplyModalProps) {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState<"reclassify" | "cancel" | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  // Who has it, where it stands and what it is filed under. Kept here so a change shows at
  // once; the list behind is reloaded as well.
  const [triage, setTriage] = useState({ assigned_to: reply.assigned_to ?? "", inbox_status: reply.inbox_status ?? "open", sentiment: reply.sentiment ?? "", sla_due_at: reply.sla_due_at, tags: reply.tags });
  const [newTag, setNewTag] = useState("");

  async function triageAction(body: Record<string, unknown>, next: Partial<typeof triage>) {
    if (!reply.reply_id) return;
    try {
      await teamAction({ ...body, reply_id: reply.reply_id });
      setTriage((current) => ({ ...current, ...next }));
      onActionDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the reply");
    }
  }

  async function addTag(tag: { id: string; name: string; color: string }) {
    if (triage.tags.some((t) => t.id === tag.id)) return;
    await triageAction({ action: "tag", tag_id: tag.id }, { tags: [...triage.tags, tag] });
  }

  async function createAndAddTag() {
    const name = newTag.trim();
    if (!name) return;
    const existing = team.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    try {
      const tag = existing ?? { id: String((await teamAction({ action: "create_tag", name })).id), name, color: "#64748b" };
      setNewTag("");
      onTeamChanged();
      await addTag(tag);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the tag");
    }
  }

  const verdict = verdictBadge(reply);
  const dispatch = (() => {
    if (!reply.dispatch_result_json) return null;
    try { return JSON.parse(reply.dispatch_result_json) as Record<string, unknown>; } catch { return null; }
  })();
  const scheduledFor = dispatch?.scheduled_for as string | undefined;

  /** Run the classifier again, or, given a verdict, set that one by hand. */
  async function handleReclassify(overrideKind?: string) {
    if (!reply.reply_id) return;
    // Setting "Unsubscribe" by hand is acted on: it is the one verdict that cannot be idly tried.
    if (overrideKind === "unsubscribe" && !confirm(`Mark this as an unsubscribe?\n\n${reply.email ?? "This address"} will be added to the do-not-contact list and taken out of every campaign.`)) return;
    setActing("reclassify");
    try {
      const r = await fetch(`/api/inbox/${reply.reply_id}/reclassify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrideKind ? { override_kind: overrideKind } : {}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Reclassify failed");
      toast.success(overrideKind ? "Verdict corrected" : "Reclassified");
      onActionDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reclassify failed");
    } finally {
      setActing(null);
    }
  }

  async function handleCancelFollowup() {
    if (!reply.reply_id) return;
    setActing("cancel");
    try {
      const r = await fetch(`/api/inbox/${reply.reply_id}/cancel-followup`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Cancel failed");
      toast.success("Follow-up cancelled");
      onActionDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActing(null);
    }
  }

  // Their latest reply came by LinkedIn (or LinkedIn is the only place they have replied):
  // the conversation and the answer are LinkedIn's, whatever email address they also have.
  const onLinkedin = !reply.detached && (reply.reply_channel === "linkedin" || (reply.channel === "linkedin" && !reply.reply_channel));

  useEffect(() => {
    if (onLinkedin || !reply.email_account_id || !reply.email) {
      setLoadingThread(false);
      return;
    }
    setLoadingThread(true);
    // A detached reply's `id` is the reply's own id, not a contact's — address the thread by
    // the reply so the conversation stays readable until it is re-linked to a contact.
    const params = new URLSearchParams(
      reply.detached
        ? { replyId: reply.reply_id ?? reply.id, emailAccountId: reply.email_account_id }
        : { targetId: reply.id, emailAccountId: reply.email_account_id },
    );
    fetch(`/api/inbox/thread?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setMessages(d.messages ?? []);
        // Pre-fill reply subject from last message
        const last = (d.messages ?? []).at(-1) as EmailMessage | undefined;
        if (last) {
          setReplySubject(last.subject.startsWith("Re:") ? last.subject : `Re: ${last.subject}`);
        }
      })
      .catch(() => toast.error("Failed to load thread"))
      .finally(() => setLoadingThread(false));
  }, [reply.id, reply.reply_id, reply.detached, reply.email_account_id, reply.email, onLinkedin]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!replyText.trim() || !reply.email || !reply.email_account_id) return;
    setSending(true);
    try {
      const r = await fetch("/api/inbox/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailAccountId: reply.email_account_id,
          to: reply.email,
          subject: replySubject,
          body: replyText,
          replyId: reply.reply_id,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Send failed");
      toast.success("Reply sent");
      setReplyText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const canReply = !!reply.email && !!reply.email_account_id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-base-200 text-xs font-semibold text-base-content/70">
              {initials(reply.full_name ?? reply.email ?? "?")}
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-base-content truncate">
                {reply.full_name ?? reply.email ?? "Unknown"}
              </div>
              <div className="text-xs text-base-content/45 mt-0.5 truncate">
                {reply.email && <span>{reply.email}</span>}
                {reply.email_account_from && (
                  <span className="ml-2 text-base-content/35">via {reply.email_account_from}</span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-base-content/40 hover:text-base-content transition-colors p-1.5 rounded-[10px] hover:bg-base-200"
          >
            <RiCloseLine size={18} />
          </button>
        </div>

        {/* Classifier verdict + dispatch trail */}
        {reply.reply_id && (
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-base-200 space-y-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${verdict.cls}`}>
                {verdict.label}
              </span>
              {reply.manually_edited === 1 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-base-100 border border-[var(--border-subtle)] text-base-content/55">
                  edited
                </span>
              )}
              {reply.reply_summary && (
                <span className="text-xs text-base-content/60">{reply.reply_summary}</span>
              )}
            </div>

            {reply.classification_error && (
              <div className="text-xs text-error">Classifier error: {reply.classification_error}</div>
            )}

            {dispatch && (
              <div className="text-xs text-base-content/50 space-y-0.5">
                {scheduledFor && <div>Follow-up scheduled for {formatDate(scheduledFor)}</div>}
                {dispatch.substitute_target_id ? <div>Substitute enrolled</div> : null}
                {dispatch.todo_id ? <div>Call task created{dispatch.phone_number ? ` · ${dispatch.phone_number}` : ""}</div> : null}
              </div>
            )}

            <div className="flex items-center gap-2 pt-0.5">
              {hasPremium && (
                <button
                  onClick={() => void handleReclassify()}
                  disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 disabled:opacity-40 transition-colors"
                >
                  {acting === "reclassify" ? <RiLoader4Line size={12} className="animate-spin" /> : null}
                  Reclassify
                </button>
              )}
              {hasPremium && (
                <select
                  value=""
                  disabled={acting !== null}
                  onChange={(e) => { if (e.target.value) void handleReclassify(e.target.value); }}
                  aria-label="Correct the verdict"
                  title="Set the verdict yourself when the classifier got it wrong. The follow-through for that verdict is applied."
                  className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)] disabled:opacity-40"
                >
                  <option value="">Correct verdict…</option>
                  {VERDICT_CHOICES.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
                </select>
              )}
              {scheduledFor && (
                <button
                  onClick={handleCancelFollowup}
                  disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] text-xs font-medium bg-error/10 text-error hover:bg-error/20 disabled:opacity-40 transition-colors"
                >
                  {acting === "cancel" ? <RiLoader4Line size={12} className="animate-spin" /> : null}
                  Cancel follow-up
                </button>
              )}
            </div>
          </div>
        )}

        {/* Triage: who has it, where it stands, when an answer is due, what it is filed under */}
        {reply.reply_id && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-3 text-xs text-base-content/55">
            <label className="flex items-center gap-1.5">Assignee
              <select className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)]" value={triage.assigned_to} onChange={(e) => void triageAction({ action: "assign", assigned_to: e.target.value || null }, { assigned_to: e.target.value })}>
                <option value="">Unassigned</option>
                {team.members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">Status
              <select className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)]" value={triage.inbox_status} onChange={(e) => void triageAction({ action: "status", status: e.target.value }, { inbox_status: e.target.value })}>
                {["open", "pending", "resolved", "closed"].map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">Sentiment
              <select className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)]" value={triage.sentiment} onChange={(e) => void triageAction({ action: "set_sentiment", sentiment: e.target.value || null }, { sentiment: e.target.value })}>
                <option value="">Not set</option>
                {["positive", "neutral", "negative"].map((sentiment) => <option key={sentiment}>{sentiment}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">Answer due
              <input
                type="datetime-local"
                className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)]"
                value={localInputValue(triage.sla_due_at)}
                onChange={(e) => {
                  const due = e.target.value ? new Date(e.target.value).toISOString() : null;
                  void triageAction({ action: "set_sla", sla_due_at: due }, { sla_due_at: due });
                }}
              />
              {(() => {
                const sla = slaLabel(triage.sla_due_at, triage.inbox_status);
                return sla ? <span className={sla.overdue ? "font-medium text-error" : "text-base-content/45"}>{sla.text}</span> : null;
              })()}
            </label>
            <div className="flex basis-full flex-wrap items-center gap-1.5">
              <span>Tags</span>
              {triage.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} onRemove={() => void triageAction({ action: "untag", tag_id: tag.id }, { tags: triage.tags.filter((t) => t.id !== tag.id) })} />
              ))}
              {team.tags.some((tag) => !triage.tags.some((t) => t.id === tag.id)) && (
                <select className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)]" value="" aria-label="Add a tag" onChange={(e) => { const tag = team.tags.find((t) => t.id === e.target.value); if (tag) void addTag(tag); }}>
                  <option value="">Add tag…</option>
                  {team.tags.filter((tag) => !triage.tags.some((t) => t.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                </select>
              )}
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createAndAddTag(); } }}
                placeholder="New tag, then Enter"
                aria-label="Create a tag"
                className="h-7 rounded-[8px] border border-[var(--border)] bg-base-100 px-2 text-xs text-base-content/75 focus:outline-none focus:border-[var(--border-focus)] w-36"
              />
            </div>
          </div>
        )}

        {onLinkedin && <LinkedinConversation reply={reply} savedReplies={savedReplies} />}

        {/* Thread */}
        {!onLinkedin && <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
          {loadingThread ? (
            <div className="flex items-center justify-center gap-2 text-base-content/30 py-10">
              <RiLoader4Line size={18} className="animate-spin" />
              <span className="text-sm">Loading thread…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center text-base-content/30 text-sm py-10">
              {canReply ? "No messages found in thread" : "No email account linked to this reply"}
            </div>
          ) : (
            messages.map((msg, i) => {
              const isFromContact = msg.from.toLowerCase().includes((reply.email ?? "").toLowerCase());
              return (
                <div
                  key={i}
                  className={`rounded-xl p-3.5 ${
                    isFromContact
                      ? "bg-base-200 border border-[var(--border-subtle)]"
                      : "bg-base-100 border border-[var(--border)] border-l-2 border-l-primary"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-base-content/70">{msg.from}</span>
                    <span className="text-xs text-base-content/35">{formatDate(msg.date)}</span>
                  </div>
                  <p className="text-sm text-base-content whitespace-pre-wrap leading-relaxed">
                    {msg.text || "(no text content)"}
                  </p>
                </div>
              );
            })
          )}
          <div ref={threadEndRef} />
        </div>}

        {/* Reply composer */}
        {!onLinkedin && canReply && (
          <div className="border-t border-[var(--border-subtle)] px-5 py-4 space-y-2.5">
            <input
              type="text"
              value={replySubject}
              onChange={(e) => setReplySubject(e.target.value)}
              placeholder="Subject"
              className="w-full bg-base-100 border border-[var(--border)] rounded-[10px] px-3 py-1.5 text-sm text-base-content placeholder:text-base-content/35 focus:outline-none focus:border-[var(--border-focus)]"
            />
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={`Reply to ${reply.full_name ?? reply.email}…`}
              rows={4}
              className="w-full bg-base-100 border border-[var(--border)] rounded-[10px] px-3 py-2 text-sm text-base-content placeholder:text-base-content/35 focus:outline-none focus:border-[var(--border-focus)] resize-none"
            />
            {savedReplies.length>0&&<select className="select select-bordered select-xs w-full" defaultValue="" onChange={(e)=>{const saved=savedReplies.find(x=>x.id===e.target.value);if(saved)setReplyText(saved.body);e.target.value="";}}><option value="">Insert saved reply…</option>{savedReplies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>}
            <div className="flex justify-end">
              <button
                onClick={handleSend}
                disabled={!replyText.trim() || sending}
                className="inline-flex items-center gap-1.5 px-4 h-10 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? <RiLoader4Line size={14} className="animate-spin" /> : <RiSendPlaneLine size={14} />}
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tag manager ───────────────────────────────────────────────────────────────

/** Rename, recolour, add and delete the workspace's inbox tags. Changes save as they are made. */
function TagManager({ tags, teamAction, onChanged, onClose }: { tags: Team["tags"]; teamAction: (body: Record<string, unknown>) => Promise<Record<string, unknown>>; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState("");

  async function act(body: Record<string, unknown>) {
    try {
      await teamAction(body);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the tag");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} />
      <div className="relative z-10 mx-4 w-full max-w-sm rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-modal)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-base-content">Inbox tags</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-[10px] p-1.5 text-base-content/40 transition-colors hover:bg-base-200 hover:text-base-content"><RiCloseLine size={18} /></button>
        </div>
        {tags.length === 0 ? (
          <p className="mb-4 text-xs text-base-content/45">No tags yet. Add one below, then apply it from a reply or the selection bar.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {tags.map((tag) => (
              <li key={tag.id} className="flex items-center gap-2">
                <input type="color" defaultValue={tag.color} aria-label={`Colour of ${tag.name}`} onBlur={(e) => { if (e.target.value !== tag.color) void act({ action: "update_tag", id: tag.id, color: e.target.value }); }} className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-[var(--border)] bg-base-100 p-0.5" />
                <input defaultValue={tag.name} aria-label="Tag name" onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== tag.name) void act({ action: "update_tag", id: tag.id, name: next }); else e.target.value = tag.name; }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="h-8 min-w-0 flex-1 rounded-[10px] border border-[var(--border)] bg-base-100 px-2.5 text-sm focus:border-[var(--border-focus)] focus:outline-none" />
                <button type="button" onClick={() => { if (confirm(`Delete the tag "${tag.name}"? It is removed from every reply that has it.`)) void act({ action: "delete_tag", id: tag.id }); }} className="rounded-[10px] px-2 py-1.5 text-xs text-base-content/45 transition-colors hover:bg-error/10 hover:text-error">Delete</button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => { e.preventDefault(); const next = name.trim(); if (!next) return; setName(""); void act({ action: "create_tag", name: next }); }} className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag" aria-label="New tag name" className="h-8 min-w-0 flex-1 rounded-[10px] border border-[var(--border)] bg-base-100 px-2.5 text-sm focus:border-[var(--border-focus)] focus:outline-none" />
          <button type="submit" disabled={!name.trim()} className="h-8 rounded-[10px] bg-primary px-3 text-xs font-medium text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-40">Add</button>
        </form>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const [replies, setReplies] = useState<InboxReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [verdict, setVerdict] = useState<string>("all");
  const [statusFilter,setStatusFilter]=useState("");
  const [sentimentFilter,setSentimentFilter]=useState("");
  const [assigneeFilter,setAssigneeFilter]=useState("");
  const [slaFilter,setSlaFilter]=useState("");
  const [checked,setChecked]=useState<Set<string>>(new Set());
  const [team,setTeam]=useState<Team>({members:[],tags:[],saved_replies:[]});
  const [tagFilter,setTagFilter]=useState("");
  const [managingTags,setManagingTags]=useState(false);
  const [selectedReply, setSelectedReply] = useState<InboxReply | null>(null);
  const [reclassifyingAll, setReclassifyingAll] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [hasPremium, setHasPremium] = useState(false);
  useEffect(() => {
    fetch("/api/premium-status").then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setHasPremium(!!d.capabilities?.replies); }).catch(() => {});
  }, []);

  function loadTeam(){fetch("/api/platform/inbox").then(r=>r.json()).then(d=>setTeam({members:d.members??[],tags:d.tags??[],saved_replies:d.saved_replies??[]})).catch(()=>{});}
  useEffect(()=>{loadTeam();},[]);

  async function teamAction(body:Record<string,unknown>):Promise<Record<string,unknown>>{const r=await fetch("/api/platform/inbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error??"Inbox update failed");return d as Record<string,unknown>;}
  async function bulkAction(action:string,value:unknown){if(!checked.size)return;try{const payload:Record<string,unknown>={action,reply_ids:[...checked]};if(action==="assign")payload.assigned_to=value==="__none"?null:value||null;if(action==="status")payload.status=value;if(action==="tag")payload.tag_id=value;if(action==="relink")payload.target_id=value??null;const result=await teamAction(payload);if(action==="relink"){const relinked=Number(result?.relinked??0);toast[relinked?"success":"info"](relinked?`Re-linked ${relinked} repl${relinked===1?"y":"ies"}`:"No contact with a matching email address — recreate the contact first");}else toast.success("Inbox updated");setChecked(new Set());load();loadTeam();}catch(e){toast.error(e instanceof Error?e.message:String(e));}}
  async function openReply(reply:InboxReply){if(reply.reply_id){try{await teamAction({action:"lock",reply_id:reply.reply_id});}catch(e){toast.error(e instanceof Error?e.message:String(e));return;}}setSelectedReply(reply);}
  async function closeReply(){const reply=selectedReply;setSelectedReply(null);if(reply?.reply_id)await teamAction({action:"unlock",reply_id:reply.reply_id}).catch(()=>{});}

  async function handleBackfill() {
    setBackfilling(true);
    try {
      const r = await fetch("/api/inbox/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Check for replies failed");

      // The sweep runs in the background — a workspace with several mailboxes takes minutes,
      // which is far longer than a request should stay open. Poll for the outcome instead.
      //
      // A failed poll is not a failed sweep. While the sweep runs, the origin is under load
      // and a poll can come back as a Cloudflare 502 with an HTML body — which used to throw
      // out of `poll.json()` and report "Check for replies failed" for a sweep that was
      // running perfectly well. Transient poll failures back off and retry; only a run of
      // them gives up, and even then the sweep itself is untouched.
      const deadline = Date.now() + 5 * 60_000;
      let state = d;
      let pollFailures = 0;
      while (state.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (pollFailures + 1), 15_000)));
        try {
          const poll = await fetch("/api/inbox/sync");
          if (!poll.ok) throw new Error(`poll ${poll.status}`);
          state = await poll.json();
          pollFailures = 0;
        } catch {
          if (++pollFailures >= 6) break;
        }
      }
      if (state.status === "error") throw new Error(state.error ?? "Check for replies failed");
      if (state.status === "running") {
        toast.info("Still checking mailboxes — replies will appear as they are found");
      } else {
        const { replies = 0, bounces = 0 } = state.result ?? {};
        toast.success(
          !replies
            ? `No new replies found${bounces ? `, ${bounces} bounce${bounces === 1 ? "" : "s"} recorded` : ""}`
            : `${replies} new repl${replies === 1 ? "y" : "ies"} captured${bounces ? `, ${bounces} bounce${bounces === 1 ? "" : "s"}` : ""}`,
        );
      }
      load();
      loadTeam();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Check for replies failed");
    } finally {
      setBackfilling(false);
    }
  }

  async function handleReclassifyAll() {
    setReclassifyingAll(true);
    try {
      const r = await fetch("/api/inbox/reclassify-all", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Reclassify failed");
      toast.success(
        d.total === 0
          ? "Nothing to reclassify"
          : `Reclassified ${d.classified}/${d.total}${d.failed ? ` (${d.failed} failed)` : ""}`,
      );
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reclassify failed");
    } finally {
      setReclassifyingAll(false);
    }
  }

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (channel !== "all") params.set("channel", channel);
    if(statusFilter)params.set("status",statusFilter);
    if(sentimentFilter)params.set("sentiment",sentimentFilter);
    if(assigneeFilter)params.set("assigned_to",assigneeFilter);
    if(slaFilter)params.set("sla",slaFilter);
    if(tagFilter)params.set("tag_id",tagFilter);
    fetch(`/api/inbox?${params}`)
      .then((r) => r.json())
      .then((d) => setReplies(d.replies ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel,statusFilter,sentimentFilter,assigneeFilter,slaFilter,tagFilter]);

  const filtered = replies.filter((r) => {
    if (verdict !== "all" && verdictKey(r) !== verdict) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (r.full_name ?? "").toLowerCase().includes(q) ||
      (r.email ?? "").toLowerCase().includes(q) ||
      (r.company ?? "").toLowerCase().includes(q) ||
      (r.workflow_name ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <>
      <Head>
        <title>Inbox — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      {selectedReply && (
        <ReplyModal
          reply={selectedReply}
          onClose={() => void closeReply()}
          onActionDone={load}
          hasPremium={hasPremium}
          savedReplies={team.saved_replies}
          team={team}
          teamAction={teamAction}
          onTeamChanged={loadTeam}
        />
      )}
      {managingTags && (
        <TagManager tags={team.tags} teamAction={teamAction} onChanged={() => { loadTeam(); load(); }} onClose={() => setManagingTags(false)} />
      )}

      {/* Header */}
      <div className="flex flex-col justify-between gap-4 mb-6 lg:flex-row lg:items-end">
        <div>
          <p className="mb-2 text-[13px] font-medium text-base-content/45">Inbox</p>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Conversations</h1>
            {!loading && filtered.length > 0 && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-[var(--border-strong)] text-base-content/70 tabular-nums">
                {filtered.length} repl{filtered.length !== 1 ? "ies" : "y"}
              </span>
            )}
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] text-base-content/50">
            <span>Contacts who replied to your outreach</span>
            {!loading && replies.length > 0 && <ExportLink resource="replies" params={Object.fromEntries(Object.entries({ channel: channel === "all" ? "" : channel, status: statusFilter, sentiment: sentimentFilter, assigned_to: assigneeFilter, sla: slaFilter, tag_id: tagFilter }).filter(([, value]) => value))} />}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasPremium && (
            <>
              <button
                onClick={handleBackfill}
                disabled={backfilling}
                title="Check the mailbox now for new replies (IMAP fetch + classify)"
                className="inline-flex items-center gap-1.5 px-3 h-9 rounded-[10px] text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {backfilling ? <RiLoader4Line size={13} className="animate-spin" /> : <RiRefreshLine size={13} />}
                {backfilling ? "Checking…" : "Check for replies"}
              </button>
              <button
                onClick={handleReclassifyAll}
                disabled={reclassifyingAll}
                title="Re-run the classifier on unclassified or failed replies (no dispatch)"
                className="inline-flex items-center gap-1.5 px-3 h-9 rounded-[10px] text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {reclassifyingAll ? <RiLoader4Line size={13} className="animate-spin" /> : null}
                {reclassifyingAll ? "Reclassifying…" : "Reclassify all"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative w-full sm:w-auto">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/35 pointer-events-none">
            <RiSearchLine size={13} />
          </span>
          <input
            type="text"
            className="w-full sm:w-56 h-9 bg-base-100 border border-[var(--border)] rounded-[10px] pl-9 pr-3 text-sm text-base-content placeholder:text-base-content/35 focus:outline-none focus:border-[var(--border-focus)]"
            placeholder="Name, email, company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="hidden sm:block w-px h-5 bg-[var(--border)]" />

        <div className="flex items-center gap-0.5 bg-base-200 rounded-[10px] p-1">
          {CHANNEL_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setChannel(tab.key)}
              className={`h-7 px-3 rounded-[7px] text-xs font-medium transition-all ${
                channel === tab.key
                  ? "bg-base-100 text-base-content shadow-[var(--shadow-raised)] border border-[var(--border-subtle)]"
                  : "text-base-content/45 hover:text-base-content/70"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="hidden sm:block w-px h-5 bg-[var(--border)]" />

        <select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value)}
          className="h-9 bg-base-100 border border-[var(--border)] rounded-[10px] px-2.5 text-xs font-medium text-base-content/70 focus:outline-none focus:border-[var(--border-focus)] cursor-pointer"
        >
          {VERDICT_FILTERS.map((v) => (
            <option key={v.key} value={v.key}>{v.label}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} className="select select-bordered select-xs"><option value="">All statuses</option>{["open","pending","resolved","closed"].map(x=><option key={x}>{x}</option>)}</select>
        <select value={sentimentFilter} onChange={e=>setSentimentFilter(e.target.value)} className="select select-bordered select-xs"><option value="">All sentiment</option>{["positive","neutral","negative"].map(x=><option key={x}>{x}</option>)}</select>
        <select value={assigneeFilter} onChange={e=>setAssigneeFilter(e.target.value)} className="select select-bordered select-xs"><option value="">All assignees</option>{team.members.map(x=><option key={x.id} value={x.id}>{x.email}</option>)}</select>
        <select value={slaFilter} onChange={e=>setSlaFilter(e.target.value)} className="select select-bordered select-xs"><option value="">Any SLA</option><option value="overdue">Overdue</option></select>
        <select value={tagFilter} onChange={e=>setTagFilter(e.target.value)} className="select select-bordered select-xs" aria-label="Filter by tag"><option value="">All tags</option>{team.tags.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <button type="button" onClick={()=>setManagingTags(true)} className="h-7 rounded-[8px] px-2 text-xs text-base-content/50 hover:bg-base-200 hover:text-base-content transition-colors">Manage tags</button>
        {checked.size>0&&<div className="flex items-center gap-1.5 rounded-[10px] bg-base-200 border border-[var(--border-subtle)] px-2.5 py-1.5"><span className="text-xs font-medium text-base-content mr-1">{checked.size} selected</span><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("assign",e.target.value);e.target.value="";}}><option value="">Assign…</option><option value="__none">Unassign</option>{team.members.map(x=><option key={x.id} value={x.id}>{x.email}</option>)}</select><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("status",e.target.value);e.target.value="";}}><option value="">Status…</option>{["open","pending","resolved","closed"].map(x=><option key={x}>{x}</option>)}</select><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("tag",e.target.value);e.target.value="";}}><option value="">Tag…</option>{team.tags.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>{filtered.some(x=>x.detached&&x.reply_id&&checked.has(x.reply_id))&&<button className="btn btn-xs" onClick={()=>void bulkAction("relink",null)} title="Attach these replies to the contact with the same email address">Re-link</button>}</div>}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 text-base-content/30 py-24">
          <span className="loading loading-spinner loading-md" />
          <span className="text-sm">Loading replies…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 text-base-content/30 py-24">
          <RiInboxLine size={36} className="opacity-30" />
          <div className="text-center">
            <p className="text-sm font-medium">
              {search ? "No replies match your search" : "No replies yet"}
            </p>
            <p className="text-xs mt-1 text-base-content/25">
              {!search && "Replies are detected automatically by the runner"}
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-base-200">
                <th className="px-3 py-2.5"><input type="checkbox" className="checkbox checkbox-xs" checked={filtered.length>0&&filtered.every(x=>x.reply_id&&checked.has(x.reply_id))} onChange={e=>setChecked(e.target.checked?new Set(filtered.flatMap(x=>x.reply_id?[x.reply_id]:[])):new Set())}/></th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-base-content/45">Contact</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-base-content/45">Channel</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-base-content/45">Verdict</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-base-content/45">From</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-base-content/45">Campaign</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-base-content/45">Replied</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-base-200 transition-colors cursor-pointer"
                  onClick={() => void openReply(r)}
                >
                  <td className="px-3 py-3" onClick={e=>e.stopPropagation()}><input type="checkbox" className="checkbox checkbox-xs" disabled={!r.reply_id} checked={!!r.reply_id&&checked.has(r.reply_id)} onChange={e=>{if(!r.reply_id)return;setChecked(cur=>{const next=new Set(cur);if(e.target.checked)next.add(r.reply_id!);else next.delete(r.reply_id!);return next;});}}/></td>
                  {/* Contact */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-base-200 text-[11px] font-semibold text-base-content/70">
                        {initials(r.full_name ?? r.email ?? "?")}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-base-content truncate">
                            {r.full_name ?? r.email ?? r.linkedin_url ?? "Unknown"}
                          </span>
                          {r.detached && (
                            <span
                              className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium border border-[var(--border)] text-base-content/50"
                              title="This reply's contact was deleted. Select it and choose Re-link to attach it to a contact."
                            >
                              No contact
                            </span>
                          )}
                          {r.linkedin_url && (
                            <a
                              href={r.linkedin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-base-content/30 hover:text-base-content transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <RiExternalLinkLine size={12} />
                            </a>
                          )}
                        </div>
                        <div className="text-xs text-base-content/45 mt-0.5 truncate">
                          {r.company ? (
                            <span>{r.company}</span>
                          ) : r.email ? (
                            <span>{r.email}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Channel */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {(r.channel === "email" || r.channel === "both") && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-[var(--border)] text-base-content/70">
                          <RiMailLine size={11} className="text-base-content/45" /> Email
                        </span>
                      )}
                      {(r.channel === "linkedin" || r.channel === "both") && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-[var(--border)] text-base-content/70">
                          <RiLinkedinBoxLine size={11} className="text-base-content/45" /> LinkedIn
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Verdict */}
                  <td className="px-4 py-3">
                    {(() => {
                      const v = verdictBadge(r);
                      return (
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${v.cls}`}>
                            {v.label}
                          </span>
                          {r.reply_summary && (
                            <span className="text-xs text-base-content/35 truncate max-w-[16rem]" title={r.reply_summary}>
                              {r.reply_summary}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>

                  {/* From (email account) */}
                  <td className="px-4 py-3">
                    {r.email_account_from ? (
                      <div><span className="text-xs text-base-content/55">{r.email_account_name ?? r.email_account_from}</span><div className="text-[10px] text-base-content/40 mt-1">{r.assignee_email??"Unassigned"} · {r.inbox_status??"open"}{r.sentiment?` · ${r.sentiment}`:""}{(()=>{const sla=slaLabel(r.sla_due_at,r.inbox_status);return sla?<span className={sla.overdue?"font-medium text-error":""}> · {sla.text}</span>:null;})()}</div>{r.tags.length>0&&<div className="flex flex-wrap gap-1 mt-1">{r.tags.map(tag=><TagChip key={tag.id} tag={tag}/>)}</div>}</div>
                    ) : (
                      <span className="text-xs text-base-content/35">—</span>
                    )}
                  </td>

                  {/* Campaign */}
                  <td className="px-4 py-3">
                    {r.workflow_id ? (
                      <Link
                        href={`/workflows/${r.workflow_id}`}
                        className="text-xs text-base-content/60 hover:text-base-content underline-offset-2 hover:underline transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.workflow_name ?? r.workflow_id}
                      </Link>
                    ) : (
                      <span className="text-xs text-base-content/35">—</span>
                    )}
                  </td>

                  {/* Replied */}
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs text-base-content/40">{timeAgo(r.replied_at)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </>
  );
}
