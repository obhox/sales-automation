import { useId, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatPrice, groupModels, modelName, type ModelInfo } from "./model";

const ITEM =
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-115 font-medium text-ink outline-none data-[selected=true]:bg-brand-tint data-[selected=true]:text-brand-strong";
const HEADING =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-10 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-label [&_[cmdk-group-heading]]:text-ink-3";

/**
 * Pick one model from the provider's list: type to search, arrow keys to move. The list
 * can run to hundreds, so it is grouped by provider and shows each model's price.
 */
export function ModelSelect({
  value,
  onChange,
  models,
  none,
  placeholder = "Choose a model",
  unavailable,
  label,
  size = "md",
  tone = "outline",
  disabled,
  id,
  className,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  models: ModelInfo[];
  /** Offers "no model" as the first choice, under this name ("No fallback", "Workspace default"). */
  none?: string;
  placeholder?: string;
  /** Shown in place of the list when there are no models to offer (no key yet, or the list did not load). */
  unavailable?: string;
  /** Names the control for screen readers when there is no visible label. */
  label?: string;
  size?: "md" | "sm";
  tone?: "outline" | "sunken";
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // The button is named by its label; this says what is chosen.
  const valueId = useId();
  const groups = groupModels(models, search);
  const typed = search.trim();
  // A model id typed in full can be used even when the list does not have it (or did not load).
  const offerTyped = /^[\w.-]+\/[\w.:-]+$/.test(typed) && !models.some((model) => model.id === typed);
  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
      align="start"
      className="w-[340px] max-w-[calc(100vw-32px)] p-0"
      trigger={
        <button
          type="button"
          id={id}
          aria-label={label}
          aria-describedby={valueId}
          disabled={disabled}
          className={cn(
            "inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-md text-left font-medium text-ink outline-none transition-colors",
            "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand-tint disabled:pointer-events-none disabled:opacity-60",
            size === "md" ? "h-[34px] px-2.5 text-12" : "h-[30px] px-2 text-11 font-semibold",
            tone === "outline" ? "border border-line-strong bg-surface hover:bg-subtle" : "border border-transparent bg-subtle hover:bg-control",
            className,
          )}
        >
          <span id={valueId} className={cn("min-w-0 flex-1 truncate", !value && !none && "text-ink-3")}>{value ? modelName(value, models) : none ?? placeholder}</span>
          <ChevronDown size={size === "md" ? 14 : 12} className="shrink-0 text-ink-2" aria-hidden="true" />
        </button>
      }
    >
      {/* Filtering is done here, by word, so "claude haiku" finds what cmdk's fuzzy match would bury. */}
      <Command shouldFilter={false} label={label ?? "Models"} loop>
        <div className="flex h-9 items-center gap-2 border-b border-line px-2.5">
          <Search size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
          <Command.Input value={search} onValueChange={setSearch} placeholder="Search models" className="h-full min-w-0 flex-1 bg-transparent text-12 text-ink outline-none placeholder:text-ink-3" />
        </div>
        <Command.List className="max-h-[300px] overflow-y-auto p-[5px]">
          {none && !typed ? (
            <Command.Item value="__none" onSelect={() => choose(null)} className={ITEM}>
              <span className="min-w-0 flex-1 truncate">{none}</span>
              {value === null ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : null}
            </Command.Item>
          ) : null}
          {groups.map((group) => (
            <Command.Group key={group.provider} heading={group.name} className={HEADING}>
              {group.models.map((model) => (
                <Command.Item key={model.id} value={model.id} onSelect={() => choose(model.id)} className={ITEM}>
                  <span className="min-w-0 flex-1 truncate">{modelName(model.id, models)}</span>
                  {model.input_price !== null || model.output_price !== null ? (
                    <span className="shrink-0 font-mono text-10 font-normal text-ink-3">
                      {formatPrice(model.input_price)} / {formatPrice(model.output_price)}
                    </span>
                  ) : null}
                  {value === model.id ? <Check size={12} strokeWidth={3} className="shrink-0" aria-hidden="true" /> : null}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          {offerTyped ? (
            <Command.Item value={`__typed:${typed}`} onSelect={() => choose(typed)} className={ITEM}>
              <span className="min-w-0 flex-1 truncate">
                Use <span className="font-mono">{typed}</span>
              </span>
            </Command.Item>
          ) : null}
          {groups.length === 0 && !offerTyped ? (
            <p className="px-2 py-5 text-center text-115 leading-[16px] text-ink-2">
              {models.length === 0 ? unavailable ?? "No models to choose from yet." : `No model matches “${typed}”.`}
              {models.length === 0 ? <span className="mt-1 block text-105 text-ink-3">A full model id, such as anthropic/claude-haiku-5.5, can be typed here.</span> : null}
            </p>
          ) : null}
        </Command.List>
        {models.length > 0 ? <p className="border-t border-line bg-subtle px-2.5 py-1.5 text-10 text-ink-3">Prices are US dollars per million tokens, read / written.</p> : null}
      </Command>
    </Popover>
  );
}
