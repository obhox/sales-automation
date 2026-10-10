import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

export type Icon = LucideIcon;

/**
 * lucide dropped its brand icons, and the design uses the LinkedIn mark on
 * every channel surface. This is the same outline glyph, drawn to lucide's
 * grid so it sits beside the other icons unchanged.
 */
export const LinkedinIcon = forwardRef<SVGSVGElement, LucideProps>(function LinkedinIcon(
  { size = 24, strokeWidth = 2, absoluteStrokeWidth, color = "currentColor", ...props },
  ref,
) {
  const width = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect width="4" height="12" x="2" y="9" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}) as unknown as LucideIcon;
