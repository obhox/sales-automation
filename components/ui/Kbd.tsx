import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-[17px] shrink-0 items-center rounded-sm bg-control px-[5px] font-mono text-10 text-ink-2", className)}>
      {children}
    </kbd>
  );
}
