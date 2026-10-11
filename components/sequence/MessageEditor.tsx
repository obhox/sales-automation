import { useRef, useState } from "react";
import { ChevronDown, Sparkles, Type } from "lucide-react";
import { toast } from "sonner";
import { Eyebrow, Input, Menu, MenuItem, MenuLabel, Spinner, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { insertAt, type MergeTag } from "./model";

const REWRITES = [
  { style: "improve", label: "Improve the wording" },
  { style: "shorter", label: "Make it shorter" },
  { style: "friendlier", label: "Make it friendlier" },
  { style: "more_direct", label: "Make it more direct" },
] as const;

interface Rewritten { body: string; subject: string | null; model: string; tag_changes: { missing: string[]; added: string[] } }

/**
 * The words of a step: an optional subject line, the message, the merge tags that can go
 * in either, and a rewrite by AI. A tag is put where the caret last was.
 */
export function MessageEditor({
  label, body, onBody, subject, onSubject, subjectPlaceholder, tags, aside, limit, rows = 9, disabled, placeholder, rewrite,
}: {
  label: string;
  body: string;
  onBody: (value: string) => void;
  /** Leave out for a step with no subject line. */
  subject?: string;
  onSubject?: (value: string) => void;
  subjectPlaceholder?: string;
  tags: MergeTag[];
  /** Beside the label, before the length ("Version A"). */
  aside?: string;
  /** A hard limit to count against (a connection note's 300). */
  limit?: number;
  rows?: number;
  disabled?: boolean;
  placeholder?: string;
  /** Leave out where rewriting is not on offer. `ready` false shows the chip but says what to set up. */
  rewrite?: { channel: "email" | "linkedin" | "connect_note"; workflowId: string; ready: boolean };
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<"subject" | "body">("body");
  const [rewriting, setRewriting] = useState(false);
  const over = limit !== undefined && body.length > limit;

  function insert(tag: string) {
    const intoSubject = focus === "subject" && subject !== undefined && onSubject;
    const element = intoSubject ? subjectRef.current : bodyRef.current;
    const text = intoSubject ? subject : body;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const next = insertAt(text, tag, start, end);
    if (intoSubject) onSubject(next.text);
    else onBody(next.text);
    // After React has put the new text in, put the caret after the tag.
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function rewriteWith(style: (typeof REWRITES)[number]["style"]) {
    if (!rewrite || rewriting) return;
    const before = { body, subject };
    setRewriting(true);
    try {
      const result = await api<Rewritten>("/api/ai/rewrite", {
        method: "POST",
        body: { channel: rewrite.channel, body, subject: rewrite.channel === "email" ? subject ?? null : undefined, style, workflow_id: rewrite.workflowId },
      });
      onBody(result.body);
      if (result.subject !== null && onSubject) onSubject(result.subject);
      toast.success("Rewritten", {
        description: `By ${result.model}. Read it before you save.`,
        action: { label: "Undo", onClick: () => { onBody(before.body); if (before.subject !== undefined && onSubject) onSubject(before.subject); } },
      });
      if (result.tag_changes.missing.length > 0) toast.warning(`The rewrite dropped ${result.tag_changes.missing.join(", ")}. Put it back if you need it.`);
      if (result.tag_changes.added.length > 0) toast.warning(`The rewrite added ${result.tag_changes.added.join(", ")}, which was not in your text.`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setRewriting(false);
    }
  }

  const shown = tags.slice(0, 5);
  const more = tags.slice(5);
  const chip = "inline-flex h-[22px] items-center rounded-[5px] bg-control px-[7px] font-mono text-10 text-ink-2 outline-none transition-colors hover:bg-brand-tint hover:text-brand-strong focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2">
      {subject !== undefined && onSubject ? (
        <>
          <Eyebrow>Subject</Eyebrow>
          <Input
            ref={subjectRef} icon={Type} value={subject} disabled={disabled} placeholder={subjectPlaceholder} aria-label="Subject" maxLength={300}
            onChange={(event) => onSubject(event.target.value)} onFocus={() => setFocus("subject")} className="font-medium"
          />
          <div className="h-1" />
        </>
      ) : null}
      <div className="flex h-4 items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className={cn("text-10 font-medium", over ? "text-bad" : "text-ink-3")}>
          {aside ? `${aside} · ` : ""}{limit !== undefined ? `${formatCount(body.length)} of ${limit}` : `${formatCount(body.length)} chars`}
        </span>
      </div>
      <Textarea
        ref={bodyRef} tone="sunken" rows={rows} value={body} disabled={disabled || rewriting} invalid={over} placeholder={placeholder} aria-label={label}
        onChange={(event) => onBody(event.target.value)} onFocus={() => setFocus("body")} className="text-115 leading-[18px]"
      />
      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-[5px]">
          {shown.map((tag) => <button key={tag.tag} type="button" title={`Insert ${tag.label}`} onClick={() => insert(tag.tag)} className={chip}>{tag.tag}</button>)}
          {more.length > 0 ? (
            <Menu align="start" width={236} trigger={<button type="button" className={cn(chip, "gap-1 font-sans font-medium")}>More<ChevronDown size={11} aria-hidden="true" /></button>}>
              <MenuLabel>Insert a merge tag</MenuLabel>
              {more.map((tag) => <MenuItem key={tag.tag} onSelect={() => insert(tag.tag)}>{tag.label}</MenuItem>)}
            </Menu>
          ) : null}
          {rewrite ? (
            rewrite.ready ? (
              <Menu
                align="end" width={208}
                trigger={
                  <button type="button" disabled={rewriting || !body.trim()} className="inline-flex h-[22px] items-center gap-1 rounded-[5px] bg-brand-tint px-[7px] text-105 font-semibold text-brand-strong outline-none transition-colors hover:bg-brand-tint/70 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50">
                    {rewriting ? <Spinner size={11} /> : <Sparkles size={11} aria-hidden="true" />}
                    {rewriting ? "Rewriting" : "AI rewrite"}
                  </button>
                }
              >
                <MenuLabel>Rewrite, keeping your merge tags</MenuLabel>
                {REWRITES.map((option) => <MenuItem key={option.style} icon={Sparkles} onSelect={() => void rewriteWith(option.style)}>{option.label}</MenuItem>)}
              </Menu>
            ) : (
              <span className="inline-flex h-[22px] items-center gap-1 rounded-[5px] bg-control px-[7px] text-105 font-medium text-ink-3" title="Add an OpenRouter key and a default model under AI & models to rewrite with AI">
                <Sparkles size={11} aria-hidden="true" />AI rewrite needs a model
              </span>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
