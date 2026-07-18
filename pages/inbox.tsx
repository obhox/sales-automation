import Head from "next/head";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
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

interface ReplyModalProps {
  reply: InboxReply;
  onClose: () => void;
  onActionDone: () => void;
  hasPremium: boolean;
  savedReplies: Array<{id:string;name:string;body:string}>;
}

function ReplyModal({ reply, onClose, onActionDone, hasPremium, savedReplies }: ReplyModalProps) {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState<"reclassify" | "cancel" | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const verdict = verdictBadge(reply);
  const dispatch = (() => {
    if (!reply.dispatch_result_json) return null;
    try { return JSON.parse(reply.dispatch_result_json) as Record<string, unknown>; } catch { return null; }
  })();
  const scheduledFor = dispatch?.scheduled_for as string | undefined;

  async function handleReclassify() {
    if (!reply.reply_id) return;
    setActing("reclassify");
    try {
      const r = await fetch(`/api/inbox/${reply.reply_id}/reclassify`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Reclassify failed");
      toast.success("Reclassified");
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

  useEffect(() => {
    if (!reply.email_account_id || !reply.email) {
      setLoadingThread(false);
      return;
    }
    setLoadingThread(true);
    const params = new URLSearchParams({ targetId: reply.id, emailAccountId: reply.email_account_id });
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
  }, [reply.id, reply.email_account_id, reply.email]);

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
                  onClick={handleReclassify}
                  disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 disabled:opacity-40 transition-colors"
                >
                  {acting === "reclassify" ? <RiLoader4Line size={12} className="animate-spin" /> : null}
                  Reclassify
                </button>
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

        {/* Thread */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
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
        </div>

        {/* Reply composer */}
        {canReply && (
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
  const [team,setTeam]=useState<{members:Array<{id:string;email:string}>;tags:Array<{id:string;name:string;color:string}>;saved_replies:Array<{id:string;name:string;body:string}>}>({members:[],tags:[],saved_replies:[]});
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

  async function teamAction(body:Record<string,unknown>){const r=await fetch("/api/platform/inbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error??"Inbox update failed");}
  async function bulkAction(action:string,value:unknown){if(!checked.size)return;try{const payload:Record<string,unknown>={action,reply_ids:[...checked]};if(action==="assign")payload.assigned_to=value==="__none"?null:value||null;if(action==="status")payload.status=value;if(action==="tag")payload.tag_id=value;await teamAction(payload);toast.success("Inbox updated");setChecked(new Set());load();loadTeam();}catch(e){toast.error(e instanceof Error?e.message:String(e));}}
  async function openReply(reply:InboxReply){if(reply.reply_id){try{await teamAction({action:"lock",reply_id:reply.reply_id});}catch(e){toast.error(e instanceof Error?e.message:String(e));return;}}setSelectedReply(reply);}
  async function closeReply(){const reply=selectedReply;setSelectedReply(null);if(reply?.reply_id)await teamAction({action:"unlock",reply_id:reply.reply_id}).catch(()=>{});}

  async function handleBackfill() {
    setBackfilling(true);
    try {
      const r = await fetch("/api/inbox/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Check for replies failed");
      toast.success(
        !d.replies
          ? "No new replies found"
          : `${d.replies} new repl${d.replies === 1 ? "y" : "ies"} captured${d.bounces ? `, ${d.bounces} bounce${d.bounces === 1 ? "" : "s"}` : ""}`,
      );
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
    fetch(`/api/inbox?${params}`)
      .then((r) => r.json())
      .then((d) => setReplies(d.replies ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel,statusFilter,sentimentFilter,assigneeFilter,slaFilter]);

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
        />
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
          <p className="mt-2 text-[15px] text-base-content/50">Contacts who replied to your outreach</p>
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
        {checked.size>0&&<div className="flex items-center gap-1.5 rounded-[10px] bg-base-200 border border-[var(--border-subtle)] px-2.5 py-1.5"><span className="text-xs font-medium text-base-content mr-1">{checked.size} selected</span><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("assign",e.target.value);e.target.value="";}}><option value="">Assign…</option><option value="__none">Unassign</option>{team.members.map(x=><option key={x.id} value={x.id}>{x.email}</option>)}</select><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("status",e.target.value);e.target.value="";}}><option value="">Status…</option>{["open","pending","resolved","closed"].map(x=><option key={x}>{x}</option>)}</select><select defaultValue="" className="select select-bordered select-xs" onChange={e=>{if(e.target.value)void bulkAction("tag",e.target.value);e.target.value="";}}><option value="">Tag…</option>{team.tags.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></div>}
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
                      <div><span className="text-xs text-base-content/55">{r.email_account_name ?? r.email_account_from}</span><div className="text-[10px] text-base-content/40 mt-1">{r.assignee_email??"Unassigned"} · {r.inbox_status??"open"}</div><div className="flex gap-1 mt-1">{r.tags.map(tag=><span key={tag.id} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{backgroundColor:`${tag.color}20`,color:tag.color}}>{tag.name}</span>)}</div></div>
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
