import { forwardRef } from "react";
import { Checkbox as RadixCheckbox, Switch as RadixSwitch } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/client/cn";

export interface CheckboxProps {
  checked: boolean | "indeterminate";
  onChange: (checked: boolean) => void;
  /** Required when there is no visible label next to the box. */
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox({ checked, onChange, label, disabled, id, className }, ref) {
  return (
    <RadixCheckbox.Root
      ref={ref}
      id={id}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={value => onChange(value === true)}
      className={cn(
        "inline-flex size-[15px] shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface text-white transition-colors",
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
        "disabled:opacity-50",
        className,
      )}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center">
        {checked === "indeterminate" ? <Minus size={11} strokeWidth={3} aria-hidden="true" /> : <Check size={10} strokeWidth={3.5} aria-hidden="true" />}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
});

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ checked, onChange, label, disabled, id, className }, ref) {
  return (
    <RadixSwitch.Root
      ref={ref}
      id={id}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={onChange}
      className={cn(
        "inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-line-strong p-0.5 transition-colors data-[state=checked]:bg-brand disabled:opacity-50",
        className,
      )}
    >
      <RadixSwitch.Thumb className="block size-3 rounded-full bg-surface transition-transform data-[state=checked]:translate-x-3" />
    </RadixSwitch.Root>
  );
});
