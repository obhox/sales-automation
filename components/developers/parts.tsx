import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";

/** The grey rounded label a scope or an event is shown in. */
export function Chip({ children, mono, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] max-w-full shrink-0 items-center rounded-full bg-control px-1.5 text-95 text-ink-2", mono && "font-mono", className)}>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A small icon that copies some text and says it did. */
export function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Tooltip label={copied ? "Copied" : label}>
      <button type="button" aria-label={label} onClick={() => void copy()} className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-control hover:text-ink">
        {copied ? <Check size={11} className="text-good" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

/** A secret shown once, in full, with a button to copy it. */
export function SecretOnce({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-line-strong bg-subtle py-1.5 pl-2.5 pr-1.5">
      <code aria-label={label} className="min-w-0 flex-1 select-all break-all font-mono text-11 leading-[16px] text-ink">{value}</code>
      <button type="button" onClick={() => void copy()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-105 font-semibold text-brand-strong hover:bg-brand-tint">
        {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Rows of grey bars for a table whose rows are on their way. */
export function RowSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-14 items-center gap-3 border-t border-line px-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-[140px] animate-pulse rounded bg-control" />
            <span className="h-2.5 w-[210px] animate-pulse rounded bg-subtle" />
          </div>
          <span className="h-3 w-[120px] animate-pulse rounded bg-subtle" />
          <span className="h-3 w-[80px] animate-pulse rounded bg-subtle" />
        </div>
      ))}
    </div>
  );
}
