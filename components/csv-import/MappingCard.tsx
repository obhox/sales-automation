import { Ban, Briefcase, Building2, CircleDashed, Clock, FileText, Globe, Link2, type LucideIcon, Mail, MapPin, Phone, PlusCircle, Sparkles, StickyNote, Tag, User, Wand2 } from "lucide-react";
import { Button, Card, LinkedinIcon, Menu, MenuItem, MenuLabel, Pill, Select, TextAction, type Icon, type SelectOption } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import {
  FIELD_LABEL, FIELD_ORDER, IGNORE, NEW_FIELD, TYPE_OPTIONS, choiceOf, cleared, columnLetter, columnStatus, mappingFooter, mappingSummary, withChoice, withType,
  type CustomType, type ImportColumn, type ImportColumnView, type ImportView,
} from "./model";
import { PanelHeader } from "./PanelHeader";

const FIELD_ICON: Record<string, Icon> = {
  first_name: User, last_name: User, full_name: User, email: Mail, linkedin_url: LinkedinIcon as unknown as LucideIcon, sales_nav_url: Link2, title: Briefcase, company: Building2, phone: Phone,
  city: MapPin, country: Globe, location: MapPin, time_zone: Clock, headline: FileText, summary: FileText, notes: StickyNote,
};
const iconOf = (choice: string): Icon => (choice === IGNORE ? Ban : choice === NEW_FIELD ? PlusCircle : choice.startsWith("custom:") ? Tag : FIELD_ICON[choice.slice(4)] ?? CircleDashed);
const GRID = "grid grid-cols-[minmax(0,170fr)_minmax(0,234fr)_minmax(0,210fr)_132px] items-center gap-3 px-3.5";

/** Step two: what each column of the file is. Every change is kept as it is made. */
export function MappingCard({ view, onMapping, onAutomap }: { view: ImportView; onMapping: (mapping: ImportColumn[]) => void; onAutomap: () => void }) {
  const options = (column: ImportColumnView): SelectOption<string>[] => {
    const current = choiceOf(column, view.options.fields);
    const used = new Set(view.columns.filter((other) => other.index !== column.index).map((other) => choiceOf(other, view.options.fields)));
    return [
      { value: IGNORE, label: "Do not import", icon: Ban },
      ...FIELD_ORDER.map((field) => ({ value: `std:${field}`, label: FIELD_LABEL[field], icon: FIELD_ICON[field], hint: used.has(`std:${field}`) ? "Takes it from the column that has it now" : undefined })),
      ...view.options.fields.map((field) => ({ value: `custom:${field.key}`, label: field.name, icon: Tag, hint: used.has(`custom:${field.key}`) ? "Takes it from the column that has it now" : `Custom field · {{${field.key}}}` })),
      { value: NEW_FIELD, label: current === NEW_FIELD && column.mapping.kind === "custom" ? column.mapping.key : "A new custom field", icon: PlusCircle, hint: current === NEW_FIELD ? "A new custom field" : "Made from this column when the import runs" },
    ];
  };

  return (
    <Card className="flex min-h-0 flex-col">
      <PanelHeader
        className="px-3.5 py-3" title="Column mapping" subtitle={mappingSummary(view)}
        actions={<Button icon={Wand2} onClick={onAutomap}>Auto-map all</Button>}
      />
      <div role="table" aria-label="Column mapping" className="flex min-h-0 flex-col">
        <div role="row" className={cn(GRID, "h-[31px] shrink-0 border-y border-line bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
          <span role="columnheader">Spreadsheet column</span>
          <span role="columnheader">Sample value</span>
          <span role="columnheader">Linki field</span>
          <span role="columnheader">Status</span>
        </div>
        <div role="rowgroup" className="flex flex-col">
          {view.columns.map((column) => {
            const choice = choiceOf(column, view.options.fields);
            const status = columnStatus(column, view);
            const isNew = choice === NEW_FIELD && column.mapping.kind === "custom";
            return (
              <div key={column.index} role="row" className={cn(GRID, "min-h-[47px] border-b border-line py-1.5")}>
                <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono text-115 font-medium text-ink" title={column.column}>{column.column}</span>
                  <span className="text-10 text-ink-3">column {columnLetter(column.index)}</span>
                </div>
                <span role="cell" className={cn("truncate text-115", column.sample ? "text-ink-2" : "text-ink-3")} title={column.sample ?? undefined}>{column.sample ?? "(empty in all rows)"}</span>
                <div role="cell" className="min-w-0">
                  <Select
                    label={`Field for ${column.column}`} value={choice} icon={iconOf(choice)} onChange={(next) => onMapping(withChoice(view, column.index, next))} options={options(column)}
                    tone={choice === IGNORE ? "sunken" : "outline"}
                    className={cn("h-[30px] w-full px-[9px]", isNew && "border-brand/30 bg-brand-tint text-brand-strong hover:bg-brand-tint", choice === IGNORE && "text-ink-2")}
                  />
                </div>
                <div role="cell" className="flex min-w-0 flex-col items-start gap-[3px]">
                  <Pill tone={status.tone} dot={status.tone !== "brand"} icon={status.tone === "brand" ? Sparkles : undefined}>{status.label}</Pill>
                  {isNew ? (
                    <Menu align="start" width={170} trigger={<button type="button" aria-label={`Kind of field for ${column.column}: ${status.note}`} className="rounded-sm text-10 text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink">{status.note}</button>}>
                      <MenuLabel>Kind of field</MenuLabel>
                      {TYPE_OPTIONS.map((type) => <MenuItem key={type.value} onSelect={() => onMapping(withType(view, column.index, type.value as CustomType))}>{type.label}{column.detected === type.value ? " · what the values look like" : ""}</MenuItem>)}
                    </Menu>
                  ) : status.note ? <span className="truncate text-10 text-ink-3">{status.note}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-b-lg bg-subtle px-3.5 py-2">
        <span className="text-11 text-ink-3">{mappingFooter(view)}</span>
        <TextAction onClick={() => onMapping(cleared(view))}>Clear all mappings</TextAction>
      </div>
    </Card>
  );
}
