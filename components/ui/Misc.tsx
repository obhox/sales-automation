import { useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
import { Toaster as SonnerToaster } from "sonner";
import { cn } from "@/lib/client/cn";
import { LinkedinIcon } from "./icons";

/** The small tinted square that marks a channel in tables and lists. */
export function ChannelBadge({ channel, size = 22, className }: { channel: "linkedin" | "email"; size?: 18 | 22 | 26; className?: string }) {
  const Glyph = channel === "linkedin" ? LinkedinIcon : Mail;
  return (
    <span
      role="img"
      aria-label={channel === "linkedin" ? "LinkedIn" : "Email"}
      style={{ width: size, height: size }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md", channel === "linkedin" ? "bg-li-tint text-li" : "bg-mail-tint text-mail", className)}
    >
      <Glyph size={size >= 26 ? 14 : 12} aria-hidden="true" />
    </span>
  );
}

/** Dark block for configuration and code, with a copy button. */
export function CodeBlock({ code, caption, className }: { code: string; caption?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-2 rounded-[9px] bg-code p-3", className)}>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-10 leading-[14px] text-code-ink">{code}</pre>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-95 text-[#6e7585]">{caption}</span>
        <button type="button" onClick={copy} className="inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md bg-code-2 px-[9px] text-105 font-semibold text-code-ink hover:bg-code-2/80">
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Toasts in the new look. Mounted once in pages/_app.tsx. */
export function Toaster() {
  return (
    <SonnerToaster
      theme="light"
      position="bottom-right"
      closeButton
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: "!rounded-lg !border !border-line-strong !bg-surface !p-3 !font-sans !text-12 !text-ink !shadow-card",
          title: "!text-12 !font-semibold",
          description: "!text-115 !text-ink-2",
          success: "[&_[data-icon]]:!text-good",
          error: "[&_[data-icon]]:!text-bad",
          warning: "[&_[data-icon]]:!text-warn",
          actionButton: "!rounded-md !bg-brand !text-white",
          cancelButton: "!rounded-md !bg-control !text-ink-2",
          closeButton: "!border-line-strong !bg-surface !text-ink-2",
        },
      }}
    />
  );
}
