import type { ReactNode } from "react";
import { Eyebrow, Field, Input, Select, Switch } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { DAYS, HOURS, hourLabel, parseDays } from "./model";

// The controls shared by an account's settings and the workspace preset: both edit the
// same limits and the same schedule, and must offer the same ranges.

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <Eyebrow>{title}</Eyebrow>
        {hint ? <p className="text-11 leading-4 text-ink-2">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A whole number typed as text, so the field can be empty while someone is editing it.
 * `""` means "not set"; the caller decides whether that is allowed.
 */
export function NumberField({
  label, value, onChange, min, max, hint, placeholder, disabled, unit,
}: {
  label: string; value: string; onChange: (value: string) => void; min: number; max: number;
  hint?: ReactNode; placeholder?: string; disabled?: boolean; unit?: string;
}) {
  const problem = numberProblem(value, min, max, placeholder !== undefined);
  return (
    <Field label={label} hint={hint} error={problem}>
      {(id) => (
        <Input
          id={id} inputMode="numeric" value={value} placeholder={placeholder} disabled={disabled} invalid={problem !== null}
          onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          trailing={unit ? <span className="shrink-0 text-105 text-ink-3">{unit}</span> : undefined}
        />
      )}
    </Field>
  );
}

/** Why a typed number cannot be saved, or null. An empty field is fine only when it may be left unset. */
export function numberProblem(value: string, min: number, max: number, optional: boolean): string | null {
  if (value === "") return optional ? null : "Required";
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return `From ${min} to ${max}`;
  return null;
}

export const toNumber = (value: string): number | null => (value === "" ? null : Number(value));
export const fromNumber = (value: number | null | undefined): string => (value == null ? "" : String(value));

export function HoursField({ start, end, onChange, disabled }: { start: number; end: number; onChange: (start: number, end: number) => void; disabled?: boolean }) {
  const options = (from: number, to: number) => HOURS.filter((hour) => hour >= from && hour <= to).map((hour) => ({ value: String(hour), label: hourLabel(hour) }));
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Field label="From">
        {(id) => <Select id={id} className="w-full" disabled={disabled} value={String(start)} onChange={(value) => onChange(Number(value), Math.max(end, Number(value) + 1))} options={options(0, 23)} />}
      </Field>
      <Field label="Until">
        {(id) => <Select id={id} className="w-full" disabled={disabled} value={String(end)} onChange={(value) => onChange(Math.min(start, Number(value) - 1), Number(value))} options={options(1, 24)} />}
      </Field>
    </div>
  );
}

export function DaysField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const on = new Set(parseDays(value));
  const toggle = (day: number) => {
    const next = new Set(on);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    // An account that works no days does nothing; keep at least one.
    if (next.size > 0) onChange([...next].sort((a, b) => a - b).join(","));
  };
  return (
    <div role="group" aria-label="Working days" className="flex gap-1.5">
      {DAYS.map((day) => (
        <button
          key={day.value} type="button" disabled={disabled} aria-pressed={on.has(day.value)} aria-label={day.name} title={day.name} onClick={() => toggle(day.value)}
          className={cn(
            "inline-flex h-8 flex-1 items-center justify-center rounded-md border text-115 font-semibold transition-colors disabled:opacity-50",
            on.has(day.value) ? "border-brand bg-brand-tint text-brand-strong" : "border-line-strong bg-surface text-ink-3 hover:bg-subtle",
          )}
        >
          {day.short}
        </button>
      ))}
    </div>
  );
}

/** A switch with its label and explanation on the left. */
export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-12 font-medium text-ink">{label}</span>
        {hint ? <span className="text-11 leading-4 text-ink-2">{hint}</span> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

let zones: string[] | null = null;
/** Every time zone name the browser knows, for the time zone field's suggestions. */
export function timeZones(): string[] {
  if (zones) return zones;
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

export function TimezoneField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const known = timeZones();
  const unknown = value !== "" && known.length > 1 && !known.includes(value);
  return (
    <Field label="Time zone" error={unknown ? "Not a time zone this browser knows. Use a name such as Europe/Berlin." : undefined}>
      {(id) => (
        <>
          <Input id={id} list={`${id}-zones`} value={value} disabled={disabled} invalid={unknown} onChange={(event) => onChange(event.target.value.trim())} placeholder="Europe/Berlin" autoComplete="off" spellCheck={false} />
          <datalist id={`${id}-zones`}>
            {known.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        </>
      )}
    </Field>
  );
}
