import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { MenuItem } from "@/components/ui";

/**
 * One of several choices in a menu where only one can be on: it shows which is chosen,
 * and choosing closes the menu. (The kit's MenuCheckItem is for lists where several can
 * be ticked, and stays open.)
 */
export function MenuChoice({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <MenuItem onSelect={onSelect}>
      <span className="flex min-w-0 items-center gap-2" aria-current={checked || undefined}>
        <Check size={12} strokeWidth={3} className={checked ? "shrink-0" : "invisible shrink-0"} aria-hidden="true" />
        <span className="truncate">{children}</span>
        {checked ? <span className="sr-only">(chosen)</span> : null}
      </span>
    </MenuItem>
  );
}
