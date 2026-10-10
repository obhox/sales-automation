import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";
import { Kbd } from "./Kbd";

const FRAME =
  "flex items-center gap-2 rounded-md text-12 text-ink transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-tint";
const TONE = {
  /** White with a border: forms and toolbars. */
  outline: "border border-line-strong bg-surface",
  /** Grey well without a border: inline editing inside cards. */
  sunken: "border border-transparent bg-subtle",
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  icon?: Icon;
  /** Anything shown at the right edge: a status icon, a unit, a button. */
  trailing?: ReactNode;
  tone?: keyof typeof TONE;
  invalid?: boolean;
  /** Classes for the outer frame (width and the like). `className` goes to the <input>. */
  frameClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon: IconGlyph, trailing, tone = "outline", invalid, frameClassName, className, disabled, ...props },
  ref,
) {
  return (
    <div
      className={cn(FRAME, TONE[tone], "h-8 px-2.5", invalid && "border-bad focus-within:border-bad focus-within:ring-bad-tint", disabled && "opacity-60", frameClassName)}
    >
      {IconGlyph ? <IconGlyph size={14} className="shrink-0 text-ink-3" aria-hidden="true" /> : null}
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn("h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3", className)}
        {...props}
      />
      {trailing}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  tone?: keyof typeof TONE;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { tone = "outline", invalid, className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "block w-full resize-y rounded-md p-2.5 text-12 leading-[17px] text-ink outline-none transition-colors placeholder:text-ink-3",
        "focus:border-brand focus:ring-2 focus:ring-brand-tint disabled:opacity-60",
        TONE[tone],
        invalid && "border-bad focus:border-bad focus:ring-bad-tint",
        className,
      )}
      {...props}
    />
  );
});

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** Keyboard hint shown at the right while the field is empty, e.g. "⌘K". */
  shortcut?: string;
  frameClassName?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, shortcut, placeholder = "Search", frameClassName, className, ...props },
  ref,
) {
  return (
    <div className={cn(FRAME, "h-8 border border-line bg-surface px-2.5", frameClassName)}>
      <Search size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={props["aria-label"] ?? placeholder}
        className={cn("h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-2 [&::-webkit-search-cancel-button]:hidden", className)}
        {...props}
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search" className="shrink-0 rounded-sm text-ink-3 hover:text-ink">
          <X size={13} aria-hidden="true" />
        </button>
      ) : shortcut ? (
        <Kbd>{shortcut}</Kbd>
      ) : null}
    </div>
  );
});

/** A label above a control, with an optional hint or error underneath. */
export function Field({
  label,
  hint,
  error,
  aside,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Shown at the right of the label row ("Verified Oct 2", "4 of 4 used"). */
  aside?: ReactNode;
  className?: string;
  /** Receives the id to put on the control so the label points at it. */
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-105 font-semibold text-ink-2">
          {label}
        </label>
        {aside ? <span className="text-105 text-ink-3">{aside}</span> : null}
      </div>
      {children(id)}
      {error ? (
        <p className="text-105 text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-105 text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}
