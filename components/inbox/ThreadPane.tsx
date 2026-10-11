import { useEffect, useRef } from "react";
import { Eye, MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState, Skeleton, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { cancelFollowup, discardLinkedin, patchConversation, reclassify, retryLinkedin } from "./api";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ThreadHeader, TriageBar, type ThreadActions } from "./ThreadHeader";
import { conversationPath, hasPending, verdictOf, type ConversationDetail, type InboxMeta } from "./model";

const SHELL = "flex h-full min-w-[380px] flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card";

/**
 * The right-hand column: one conversation, read and answered.
 *
 * It is asked for again by itself only while something in it is still on its way (a
 * LinkedIn message waiting to be sent, an email the queue is retrying), which is the one
 * thing the old inbox polled for as well.
 */
export function ThreadPane({
  conversationId, meta, me, role, canEdit, listLoading, hasConversations, onChanged, onOpenTags, onOpenSavedReplies, onOpenRelink, onOpenBooking,
}: {
  conversationId: string | null;
  /** The list has not answered yet, so it is too early to say there is nothing to read. */
  listLoading: boolean;
  meta: InboxMeta | undefined;
  me: string | null;
  role: string;
  canEdit: boolean;
  /** Whether the list has anything in it, which changes what an empty pane says. */
  hasConversations: boolean;
  /** Something about the conversation changed that the list and the sidebar count show. */
  onChanged: () => void;
  onOpenTags: () => void;
  onOpenSavedReplies: () => void;
  onOpenRelink: (detail: ConversationDetail) => void;
  onOpenBooking: () => void;
}) {
  const { data, error, isLoading, mutate } = useApi<ConversationDetail>(conversationId ? conversationPath(conversationId) : null, undefined, {
    refreshInterval: (latest) => (hasPending(latest) ? 5000 : 0),
  });
  // While another conversation's request is on its way, the previous one's data is still what the cache hands back.
  const detail = data && data.conversation.id === conversationId ? data : undefined;
  const readFor = useRef<string | null>(null);

  // Opening a conversation reads it, for the member who opened it.
  const unread = detail?.conversation.unread ?? false;
  useEffect(() => {
    if (!detail || !me || !unread || readFor.current === `${detail.conversation.id}:${detail.conversation.last_message_at}`) return;
    readFor.current = `${detail.conversation.id}:${detail.conversation.last_message_at}`;
    patchConversation(detail.conversation.id, { read: true }).then((next) => { void mutate(next, { revalidate: false }); onChanged(); }).catch(() => { readFor.current = null; });
  }, [detail, unread, me, mutate, onChanged]);

  const skeleton = (
    <section className={SHELL} aria-label="Conversation" aria-busy="true">
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-line px-3.5"><Skeleton className="size-[34px] rounded-full" /><div className="flex flex-col gap-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div></div>
      <div className="h-[45px] shrink-0 border-b border-line bg-subtle" />
      <div className="flex flex-1 flex-col gap-3 p-3.5"><Skeleton className="h-14 w-full rounded-lg" /><Skeleton className="h-28 w-full rounded-lg" /><Skeleton className="h-24 w-full rounded-lg" /></div>
    </section>
  );
  if (!conversationId && listLoading) return skeleton;
  if (!conversationId) {
    return (
      <section className={SHELL} aria-label="Conversation">
        <EmptyState icon={MessagesSquare} title={hasConversations ? "Choose a conversation" : "Nothing to read yet"} className="m-auto">
          {hasConversations ? "Pick one from the list to read it and answer." : "Replies to your campaigns will open here."}
        </EmptyState>
      </section>
    );
  }
  if (error && !detail) {
    return <section className={SHELL} aria-label="Conversation"><ErrorState className="m-auto" message={error.status === 404 ? "This conversation is not in this workspace any more." : errorMessage(error)} onRetry={() => void mutate()} /></section>;
  }
  if (!detail || (isLoading && !detail)) return skeleton;

  const id = detail.conversation.id;
  const apply = (next: ConversationDetail) => { void mutate(next, { revalidate: false }); onChanged(); };
  const failed = (cause: unknown) => { toast.error(errorMessage(cause)); void mutate(); };
  const refresh = () => { void mutate(); onChanged(); };

  const actions: ThreadActions = {
    patch: (body, done) => {
      // Marking it unread must not be undone a moment later by "opening reads it".
      if (body.read === false) readFor.current = `${id}:${detail.conversation.last_message_at}`;
      patchConversation(id, body).then((next) => { apply(next); if (done) toast.success(done); }).catch(failed);
    },
    reclassify: async (verdict) => {
      const reply = detail.latest_reply;
      if (!reply) return;
      if (verdict === "unsubscribe") {
        const ok = await confirm({
          title: `Mark ${detail.conversation.name} as unsubscribed?`,
          body: "They go on the do-not-contact list for the whole workspace and are taken out of every campaign. Use this when they have asked not to be contacted.",
          confirmLabel: "Mark as unsubscribe", tone: "danger",
        });
        if (!ok) return;
      }
      try {
        await reclassify(reply.id, verdict);
        toast.success(verdict ? `Marked as ${verdictOf(verdict).label.toLowerCase()}` : "Read again");
        refresh();
      } catch (cause) { failed(cause); }
    },
    cancelFollowup: async () => {
      if (!detail.followup) return;
      const ok = await confirm({ title: "Cancel the follow-up?", body: "The campaign email that was put back for them will not be sent, and their email steps in that campaign stop. This cannot be undone from here.", confirmLabel: "Cancel the follow-up", cancelLabel: "Keep it" });
      if (!ok) return;
      try { await cancelFollowup(detail.followup.reply_id); toast.success("The follow-up was cancelled"); refresh(); } catch (cause) { failed(cause); }
    },
    readLinkedin: () => {
      api("/api/inbox/linkedin-thread", { method: "POST", body: { target_id: detail.conversation.target_id } })
        .then(() => toast.message("Asked for their LinkedIn inbox to be read", { description: "New messages appear here within about a minute, when the LinkedIn account is running." }))
        .catch(failed);
    },
    openRelink: () => onOpenRelink(detail),
    openTags: onOpenTags,
    openSavedReplies: onOpenSavedReplies,
  };

  return (
    <section className={SHELL} aria-label={`Conversation with ${detail.conversation.name}`}>
      <ThreadHeader detail={detail} meta={meta} canEdit={canEdit} actions={actions} />
      <TriageBar detail={detail} meta={meta} me={me} role={role} canEdit={canEdit} actions={actions} />
      <MessageList
        detail={detail} meta={meta} canEdit={canEdit} onReclassify={() => actions.reclassify()}
        actions={{
          retryLinkedin: (messageId, confirmed) => { retryLinkedin(messageId, confirmed).then(() => { toast.success("It will be sent again"); refresh(); }).catch(failed); },
          discardLinkedin: (messageId) => { discardLinkedin(messageId).then(() => { toast.success("Discarded"); refresh(); }).catch(failed); },
        }}
      />
      {canEdit ? (
        <Composer
          key={id} detail={detail} meta={meta} me={me} isAdmin={role === "admin" || role === "owner"}
          onRefresh={() => void mutate()} onManageSavedReplies={onOpenSavedReplies} onSetBookingLink={onOpenBooking}
          onSent={(next, how) => {
            apply(next);
            toast.success(how.status === "queued" ? (how.channel === "linkedin" ? "Queued. It is sent on LinkedIn within about a minute." : "The mail server did not answer. It will be tried again by itself.") : how.closed ? "Sent, and the conversation is closed" : "Sent");
          }}
        />
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-subtle px-3.5 py-3 text-11 text-ink-2">
          <Eye size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
          You have read-only access. A member of the workspace can answer and change this conversation.
        </div>
      )}
    </section>
  );
}
