import { useMemo, useState } from "react";
import { ChevronDown, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { Button, Pill } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { SPAM_LEVEL_LABEL, SPAM_MODE_LABEL, checkSpam, cleanSpam, type SpamFinding, type SpamLevel, type SpamMode } from "@/lib/email/spam-check";
import type { SpamView } from "@/lib/outreach/preview";

const TONE: Record<SpamLevel, "good" | "warn" | "bad"> = { clean: "good", review: "warn", risky: "bad" };
const SEVERITY_TEXT = { high: "text-bad", medium: "text-warn", low: "text-ink-3" } as const;

function FindingRow({ finding, mode }: { finding: SpamFinding; mode: SpamMode }) {
  const mends = finding.replacement !== null;
  return (
    <li className="flex flex-col gap-0.5 border-t border-line py-1.5 first:border-t-0">
      <p className="text-115 leading-4 text-ink">
        <span className={cn("font-semibold", SEVERITY_TEXT[finding.severity])}>&ldquo;{finding.text.trim()}&rdquo;</span>
        <span className="text-ink-3"> · in the {finding.field}</span>
      </p>
      <p className="text-11 leading-4 text-ink-2">
        {finding.why}
        {mends
          ? ` ${mode === "remove" ? "Taken out when it is sent" : "Can be taken out"}${finding.replacement ? `, as "${finding.replacement}"` : ""}.`
          : " Rewrite it: it cannot be taken out without changing what you say."}
      </p>
    </li>
  );
}

/**
 * The spam check of an email as it is typed: what is flagged, why, and a button that takes
 * out what can be taken out of the text. Nothing is sent anywhere; the rules run here.
 */
export function SpamCheck({ subject, body, mode, disabled, onClean }: {
  subject: string; body: string; mode: SpamMode; disabled?: boolean;
  /** Apply the cleaned text to the editor. */
  onClean?: (text: { subject: string; body: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const report = useMemo(() => (mode === "off" ? null : checkSpam({ subject, body })), [mode, subject, body]);
  if (!report) return null;
  const mendable = report.findings.some((finding) => finding.replacement !== null);
  const Glyph = report.level === "clean" ? ShieldCheck : ShieldAlert;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-subtle px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setOpen(!open)} disabled={report.findings.length === 0} aria-expanded={open} className="flex min-w-0 items-center gap-1.5 text-left outline-none disabled:cursor-default">
          <Glyph size={14} aria-hidden="true" className={cn("shrink-0", report.level === "clean" ? "text-good" : report.level === "risky" ? "text-bad" : "text-warn")} />
          <span className="text-115 font-semibold text-ink">Spam check</span>
          <Pill tone={TONE[report.level]}>{report.findings.length === 0 ? SPAM_LEVEL_LABEL.clean : `${report.findings.length} flagged · ${SPAM_LEVEL_LABEL[report.level]}`}</Pill>
          {report.findings.length > 0 ? <ChevronDown size={13} aria-hidden="true" className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-180")} /> : null}
        </button>
        <span className="shrink-0 text-105 text-ink-3">{SPAM_MODE_LABEL[mode]}</span>
      </div>
      {open && report.findings.length > 0 ? (
        <>
          <ul>{report.findings.map((finding, index) => <FindingRow key={`${finding.field}:${finding.start}:${index}`} finding={finding} mode={mode} />)}</ul>
          {onClean && !disabled && mendable ? (
            <div className="flex items-center gap-2 border-t border-line pt-1.5">
              <Button size="sm" icon={Sparkles} onClick={() => { const cleaned = cleanSpam({ subject, body }); onClean({ subject: cleaned.subject, body: cleaned.body }); }}>Remove what can be removed</Button>
              <span className="text-105 text-ink-3">Edits the text above. Merge tags are kept.</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** What the filter made of one email in a preview: the flags, and what was taken out when it is sent. */
export function SpamNote({ spam }: { spam: SpamView }) {
  const [open, setOpen] = useState(spam.level !== "clean");
  const flagged = spam.findings.length;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-subtle px-2 py-1.5">
      <button type="button" onClick={() => setOpen(!open)} disabled={flagged === 0} aria-expanded={open} className="flex items-center gap-1.5 text-left outline-none disabled:cursor-default">
        {spam.level === "clean" ? <ShieldCheck size={13} aria-hidden="true" className="text-good" /> : <ShieldAlert size={13} aria-hidden="true" className={spam.level === "risky" ? "text-bad" : "text-warn"} />}
        <span className="text-11 font-semibold text-ink">Spam check</span>
        <Pill tone={TONE[spam.level]}>{flagged === 0 ? SPAM_LEVEL_LABEL.clean : `${flagged} flagged · ${SPAM_LEVEL_LABEL[spam.level]}`}</Pill>
        <span className="text-105 text-ink-3">{SPAM_MODE_LABEL[spam.mode]}</span>
      </button>
      {open && flagged > 0 ? (
        <>
          {spam.mode === "remove" ? (
            <p className="text-11 leading-4 text-ink-2">
              {spam.removed.length > 0
                ? `Shown as it will be sent. Taken out: ${spam.removed.map((entry) => `"${entry.text.trim()}"${entry.replacement ? ` → "${entry.replacement}"` : ""}`).join(", ")}.`
                : "Nothing here can be taken out without changing what it says, so it will be sent as written."}
            </p>
          ) : (
            <p className="text-11 leading-4 text-ink-2">This campaign sends it as written. Switch the spam filter to Remove in its settings to have these taken out.</p>
          )}
          <ul>{(spam.mode === "remove" && spam.removed.length > 0 ? spam.left : spam.findings).map((finding, index) => <FindingRow key={`${finding.field}:${finding.start}:${index}`} finding={finding} mode={spam.mode} />)}</ul>
        </>
      ) : null}
    </div>
  );
}
