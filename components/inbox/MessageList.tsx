import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Clock, GitBranch, Mail, Paperclip, Sparkles, TriangleAlert } from "lucide-react";
import { Avatar, Button, LinkedinIcon, Spinner, TextAction, confirm } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatDateTime, plural } from "@/lib/client/format";
import { attachmentPath, campaignLine, dispatchLine, fileSize, summaryOf, type ConversationDetail, type InboxMeta, type ThreadMessage } from "./model";

/** How many of the latest messages are shown before the rest are asked for. */
const SHOWN_AT_FIRST = 3;

/**
 * What the reply was read as, with how sure the reading is and what to do next. This is
 * a paid capability: where the build has none, or the reply has not been read, the card
 * says so plainly.
 */
function Summary({ detail, meta, canEdit, onReclassify }: { detail: ConversationDetail; meta: InboxMeta | undefined; canEdit: boolean; onReclassify: () => void }) {
  const reply = detail.verdict_reply;
  const latest = detail.latest_reply;
  if (!latest) return null;
  const shell = (title: string, body: string, action?: React.ReactNode, tone: "brand" | "plain" | "bad" = "brand") => (
    <section className={cn("flex w-full shrink-0 items-start gap-[9px] rounded-lg p-2.5", tone === "brand" ? "bg-brand-tint" : tone === "bad" ? "bg-bad-tint" : "bg-subtle")} aria-label="Summary of the reply">
      {tone === "bad" ? <TriangleAlert size={15} className="mt-px shrink-0 text-bad" aria-hidden="true" /> : <Sparkles size={15} className={cn("mt-px shrink-0", tone === "brand" ? "text-brand" : "text-ink-3")} aria-hidden="true" />}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <h3 className="text-115 font-semibold leading-[15px] text-ink">{title}</h3>
        {body ? <p className="text-11 leading-4 text-ink-2">{body}</p> : null}
      </div>
      {action}
    </section>
  );
  const again = canEdit && meta?.capabilities.classify ? <TextAction className="shrink-0" onClick={onReclassify}>{latest.verdict || latest.classification_error ? "Read it again" : "Read it now"}</TextAction> : undefined;

  if (latest.classification_error && !latest.verdict) return shell("This reply could not be read", latest.classification_error, again, "bad");
  if (!reply) {
    return meta && !meta.capabilities.classify
      ? shell("Summaries are not available", "This build does not read replies. Set the verdict by hand from the menu above.", undefined, "plain")
      : shell("Not read yet", "This reply has no verdict yet.", again, "plain");
  }
  const summary = summaryOf(reply);
  return shell(summary.title, [summary.detail, dispatchLine(reply)].filter(Boolean).join(" "));
}

function Attachments({ files }: { files: ThreadMessage["attachments"] }) {
  if (files.length === 0) return null;
  return (
    <ul className="flex w-full flex-wrap gap-1.5" aria-label="Files">
      {files.map((file) => (
        <li key={file.id}>
          {file.kept ? (
            <a href={attachmentPath(file.id)} download={file.filename} className="inline-flex h-6 max-w-[240px] items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-11 font-medium text-ink-2 hover:border-line-strong hover:text-ink">
              <Paperclip size={11} className="shrink-0" aria-hidden="true" /><span className="truncate">{file.filename}</span><span className="shrink-0 text-ink-3">{fileSize(file.size_bytes)}</span>
            </a>
          ) : (
            <span className="inline-flex h-6 max-w-[280px] items-center gap-1.5 rounded-md border border-dashed border-line px-2 text-11 text-ink-3" title="This file was too large to keep. It is in the mailbox.">
              <Paperclip size={11} className="shrink-0" aria-hidden="true" /><span className="truncate">{file.filename}</span><span className="shrink-0">{fileSize(file.size_bytes)}, not kept</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface MessageActions {
  retryLinkedin: (messageId: string, confirmed: boolean) => void;
  discardLinkedin: (messageId: string) => void;
}

function Message({ message, contactName, contactCompany, canEdit, actions }: { message: ThreadMessage; contactName: string; contactCompany: string | null; canEdit: boolean; actions: MessageActions }) {
  const mine = message.direction === "out";
  const channel = message.channel === "linkedin" ? { label: message.kind === "inmail" ? "InMail" : "LinkedIn", box: "bg-li-tint text-li", Glyph: LinkedinIcon } : { label: "Email", box: "bg-mail-tint text-mail", Glyph: Mail };
  const name = message.author.name ?? (mine ? "You" : contactName);
  const from = mine ? (message.author.via ? `via ${message.author.via}` : message.author.kind === "linkedin_account" ? "on LinkedIn" : null) : message.author.via ?? contactCompany;
  const sub = from === name ? null : from;
  const campaign = campaignLine(message);
  const waiting = message.status === "queued" || message.status === "sending";

  if (message.source === "marker") {
    return (
      <div className="flex w-full shrink-0 justify-center">
        <span className="inline-flex min-h-[22px] items-center gap-[5px] rounded-full bg-control px-[9px] py-0.5 text-105 font-medium text-ink-2">
          <Clock size={11} aria-hidden="true" />Marked as replied {message.channel === "linkedin" ? "on LinkedIn" : "by email"} · {formatDateTime(message.at)}. The message itself was not stored.
        </span>
      </div>
    );
  }

  return (
    <article className={cn("flex w-full shrink-0 flex-col gap-2 border border-line p-3", mine ? "rounded-lg bg-surface shadow-card" : "rounded-[9px] bg-subtle")} aria-label={`${mine ? "Sent" : "Received"} ${formatDateTime(message.at)}`}>
      <header className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={name} size={24} tint={mine ? "bg-brand-tint" : "bg-li-tint"} className={cn("text-95", mine ? "text-brand-strong" : "text-li")} />
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-12 font-semibold text-ink">{name}</span>
            {sub ? <span className="truncate text-105 text-ink-3">{sub}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[7px]">
          <span className={cn("inline-flex h-[17px] items-center gap-1 rounded px-1.5 text-10 font-semibold", channel.box)}><channel.Glyph size={10} aria-hidden="true" />{channel.label}</span>
          <time dateTime={message.at} className="text-105 text-ink-3">{formatDateTime(message.at)}</time>
        </div>
      </header>
      {message.subject ? <p className="text-115 font-semibold text-ink">{message.subject}</p> : null}
      <p className="w-full whitespace-pre-wrap break-words text-115 leading-[17px] text-ink-2">{message.body}</p>
      <Attachments files={message.attachments} />
      {campaign ? (
        <footer className="flex w-full items-center gap-1.5 text-105 text-ink-3"><GitBranch size={11} className="shrink-0" aria-hidden="true" /><span className="truncate">{campaign}</span></footer>
      ) : null}

      {waiting ? (
        <footer className="flex w-full items-center gap-2 rounded-md bg-subtle px-2 py-1.5 text-11 text-ink-2" role="status">
          <Spinner size={12} label="Waiting to be sent" />
          <span className="flex-1">{message.status === "sending" ? "Being sent now." : message.channel === "linkedin" ? "Waiting to be sent on LinkedIn. It goes within about a minute." : "Waiting in the mail queue. It will be tried again by itself."}</span>
          {canEdit && message.linkedin_message_id && message.status === "queued" ? <TextAction onClick={() => actions.discardLinkedin(message.linkedin_message_id!)}>Discard</TextAction> : null}
        </footer>
      ) : null}
      {message.status === "failed" || message.status === "uncertain" ? (
        <footer className={cn("flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-11", message.status === "failed" ? "bg-bad-tint text-bad" : "bg-warn-tint text-warn")} role="alert">
          <TriangleAlert size={12} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{message.status === "failed" ? "Not sent. " : "It is not known whether this was sent. "}{message.error ?? ""}</span>
          {canEdit && message.linkedin_message_id && message.sent_here ? (
            <>
              <Button
                size="xs"
                onClick={async () => {
                  if (message.status === "uncertain") {
                    const ok = await confirm({ title: "Send it again?", body: "This message may already have been delivered. Look at the conversation on LinkedIn first: if it is there, discard this one instead.", confirmLabel: "I checked, send it again" });
                    if (!ok) return;
                  }
                  actions.retryLinkedin(message.linkedin_message_id!, message.status === "uncertain");
                }}
              >
                Send again
              </Button>
              <Button size="xs" variant="ghost" onClick={() => actions.discardLinkedin(message.linkedin_message_id!)}>Discard</Button>
            </>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

/** The middle of the thread: the summary, then every stored message, oldest first, ending at the newest. */
export function MessageList({ detail, meta, canEdit, onReclassify, actions }: { detail: ConversationDetail; meta: InboxMeta | undefined; canEdit: boolean; onReclassify: () => void; actions: MessageActions }) {
  const [all, setAll] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = detail.messages;
  const hidden = all ? 0 : Math.max(0, messages.length - SHOWN_AT_FIRST);
  const shown = hidden ? messages.slice(hidden) : messages;
  const lastId = messages[messages.length - 1]?.id;

  // A conversation opens at its newest message, and follows a new one when it arrives.
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [detail.conversation.id, lastId, all]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-[11px] overflow-y-auto p-3.5" tabIndex={0} aria-label="Messages">
      <Summary detail={detail} meta={meta} canEdit={canEdit} onReclassify={onReclassify} />
      {detail.followup ? (
        <div className="flex w-full shrink-0 items-center gap-2 rounded-lg bg-warn-tint px-2.5 py-2 text-11 text-warn" role="status">
          <Clock size={13} className="shrink-0" aria-hidden="true" />
          <span>A campaign follow-up is waiting for them{detail.followup.scheduled_for ? `, due ${formatDateTime(detail.followup.scheduled_for)}` : ""}. Cancel it from the menu above if you are answering yourself.</span>
        </div>
      ) : null}
      {hidden ? (
        <div className="flex w-full shrink-0 justify-center">
          <button type="button" onClick={() => setAll(true)} className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-control px-[9px] text-105 font-medium text-ink-2 hover:text-ink">
            <ChevronsUpDown size={11} aria-hidden="true" />{hidden} earlier {plural(hidden, "message", "messages")}
          </button>
        </div>
      ) : null}
      {shown.map((message) => <Message key={message.id} message={message} contactName={detail.conversation.name} contactCompany={detail.conversation.company} canEdit={canEdit} actions={actions} />)}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}
