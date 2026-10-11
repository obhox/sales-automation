import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";
import { Spinner } from "./Spinner";

/** A grey block that stands in for content while it loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-control", className)} />;
}

/** What a list, table or panel shows when there is nothing in it. */
export function EmptyState({
  icon: IconGlyph,
  title,
  children,
  action,
  className,
}: {
  icon?: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {IconGlyph ? (
        <span className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-subtle text-ink-3">
          <IconGlyph size={16} aria-hidden="true" />
        </span>
      ) : null}
      <p className="text-13 font-semibold text-ink">{title}</p>
      {children ? <p className="max-w-[360px] text-115 leading-[17px] text-ink-2">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Centred spinner for a panel whose data is on its way. */
export function LoadingState({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 px-6 py-10 text-115 text-ink-3", className)}>
      <Spinner size={14} label={label} />
      <span>{label}…</span>
    </div>
  );
}

/** What a panel shows when its request failed, with a way to try again. */
export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      <p className="text-13 font-semibold text-ink">This did not load</p>
      <p className="max-w-[360px] text-115 leading-[17px] text-ink-2">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 text-11 font-semibold text-brand-strong hover:underline">
          Try again
        </button>
      ) : null}
    </div>
  );
}
