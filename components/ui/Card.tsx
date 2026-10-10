import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/client/cn";

/** The white panel every screen is built from. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-surface shadow-card", className)} {...props} />;
}

/** Title, optional subtitle and count on the left; actions on the right. */
export function CardHeader({
  title,
  subtitle,
  badge,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Sits beside the title (a count pill, a status). */
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-[7px]">
          <h2 className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{title}</h2>
          {badge}
        </div>
        {subtitle ? <p className="truncate text-11 text-ink-3">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The small uppercase caption used above fields, KPIs and rail sections. */
export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-10 font-semibold uppercase tracking-label text-ink-3", className)} {...props} />;
}

/** A text-only action in the brand colour ("View all", "Edit", "Manage"). */
export function TextAction({ className, ...props }: HTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("text-11 font-semibold text-brand-strong hover:underline", className)} {...props} />;
}
