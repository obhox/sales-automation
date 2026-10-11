import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's stock names. Without this it cannot tell
// `text-125` (a size) from `text-ink` (a colour) and drops one of them.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["85", "9", "95", "10", "105", "11", "115", "12", "125", "13", "135", "14", "15", "18", "22", "25"],
      color: [
        "page", "surface", "subtle", "control", "line", "line-strong", "scrim",
        "ink", "ink-2", "ink-3",
        "brand", "brand-strong", "brand-tint",
        "good", "good-tint", "warn", "warn-tint", "bad", "bad-tint",
        "li", "li-tint", "mail", "mail-tint",
        "code", "code-2", "code-ink",
      ],
      tracking: ["label", "snug", "title", "figure"],
      shadow: ["card", "seg"],
      animate: ["fade-in", "pop-in", "slide-in"],
    },
  },
});

/** Join class names; later Tailwind classes win over earlier ones that set the same thing. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
