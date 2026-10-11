import { useState, type DragEvent, type KeyboardEvent } from "react";
import {
  CornerDownLeft, CornerDownRight, Eye, GitBranch, GripVertical, Mail, MessageSquare, MessageSquareDashed, Plus, Send, Timer, TriangleAlert, UserPlus, X,
} from "lucide-react";
import { Button, ChannelBadge, Field, Input, Menu, MenuItem, Popover, Select, Switch, Tooltip, type Icon } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount, plural } from "@/lib/client/format";
import {
  DAY, HOUR, STEP_CHOICES, TRACK_LABEL, addStep, gateSubline, gateTitle, isSending, laneItems, leader, letter, moveStep, nudgeStep, outcomeLabel, removeRow, stepCount,
  stepProblems, stepSubline, stepTitle, updateRow, versionShares, versionsOf, waitLabel,
  type BuilderData, type Doc, type Gate, type LaneItem, type Row, type SendType, type Track,
} from "./model";

const STEP_ICON: Record<string, Icon> = { visit: Eye, connect: UserPlus, message: MessageSquare, sales_inmail: Send, email: Mail };
const TINT: Record<Track, string> = { linkedin: "bg-li-tint text-li", email: "bg-mail-tint text-mail" };

export interface Selection { ref: string; what: "step" | "gate" }

/** One track of the sequence: its switch, its steps with the waits and conditions between them, and the way to add another. */
export function Lane({
  doc, track, data, selected, readOnly, onChange, onSelect,
}: {
  doc: Doc;
  track: Track;
  data: BuilderData;
  selected: Selection | null;
  readOnly: boolean;
  onChange: (doc: Doc) => void;
  onSelect: (selection: Selection | null) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  /** The step the dragged one would land in front of, or "end". */
  const [over, setOver] = useState<string | null>(null);
  const items = laneItems(doc, track);
  const steps = stepCount(doc, track);
  const enabled = track === "linkedin" ? doc.settings.linkedin_track_enabled : doc.settings.email_track_enabled;
  const customKeys = data.custom_fields.map((field) => field.key);
  const titles = new Map(items.filter((item) => isSending(item.row)).map((item) => [item.row.ref, stepTitle(item)]));
  const messages = items.filter((item) => item.row.step_type === "message");

  function add(type: SendType) {
    const next = addStep(doc, track, type);
    onChange(next.doc);
    onSelect({ ref: next.ref, what: "step" });
  }

  function drop(beforeRef: string | null) {
    if (dragging) onChange(moveStep(doc, dragging, beforeRef));
    setDragging(null);
    setOver(null);
  }

  const dropTarget = (key: string) => (readOnly ? {} : {
    onDragOver: (event: DragEvent) => {
      if (!dragging || dragging === key) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== key) setOver(key);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      drop(key === "end" ? null : key);
    },
  });

  return (
    <section aria-label={TRACK_LABEL[track]} className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[30px] items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ChannelBadge channel={track} />
          <h2 className="text-13 font-semibold tracking-[-0.1px] text-ink">{TRACK_LABEL[track]}</h2>
          <span className="text-11 text-ink-3">{steps} {plural(steps, "step", "steps")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[7px]">
          <span className="text-105 font-semibold uppercase tracking-label text-ink-3">{enabled ? "Enabled" : "Off"}</span>
          <Switch
            checked={enabled} disabled={readOnly} label={`${TRACK_LABEL[track]} enabled`}
            onChange={(on) => onChange({ ...doc, settings: { ...doc.settings, [track === "linkedin" ? "linkedin_track_enabled" : "email_track_enabled"]: on } })}
          />
        </div>
      </header>

      {track === "email" && stepCount(doc, "linkedin") > 0 && steps > 0 ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-11 text-ink-2">Starts</span>
          <Select
            size="sm" tone="sunken" label="When the email track starts" disabled={readOnly} value={doc.settings.email_start}
            onChange={(value) => onChange({ ...doc, settings: { ...doc.settings, email_start: value } })}
            options={[
              { value: "enrolment", label: "when a contact is enrolled", hint: "Runs alongside LinkedIn from the first day" },
              { value: "handover", label: "when LinkedIn hands over", hint: "Only for contacts a LinkedIn condition sends here" },
            ]}
          />
        </div>
      ) : null}
      {!enabled && steps > 0 ? <p className="mt-1.5 text-11 leading-4 text-warn">Switched off: contacts on this track wait where they are until it is switched back on.</p> : null}

      <div className="h-2.5" />
      <ol className={cn("flex flex-col", !enabled && "opacity-60")}>
        {items.map((item, index) => {
          const previous = items[index - 1];
          const { row } = item;
          if (!isSending(row)) {
            return (
              <li key={row.ref} className="flex flex-col">
                <WaitChip row={row} readOnly={readOnly} onSet={(seconds) => onChange(seconds > 0 ? updateRow(doc, row.ref, { delay_seconds: seconds }) : removeRow(doc, row.ref))} removable={!item.gate} />
                {item.gate ? (
                  <>
                    <GateCard gate={item.gate} counts={data.sequence.gate_counts[row.ref]} titles={titles} data={data} selected={selected?.what === "gate" && selected.ref === row.ref} onSelect={() => onSelect({ ref: row.ref, what: "gate" })} />
                    <Connector />
                  </>
                ) : null}
              </li>
            );
          }
          const problems = stepProblems(row, data.templates, customKeys);
          const isSelected = selected?.what === "step" && selected.ref === row.ref;
          return (
            <li key={row.ref} className="flex flex-col" {...dropTarget(row.ref)}>
              {previous && isSending(previous.row) ? <Connector /> : null}
              {over === row.ref && dragging ? <div className="mb-1 h-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
              <StepCard
                item={item} track={track} selected={isSelected} problems={problems} readOnly={readOnly} dragging={dragging === row.ref}
                subline={stepSubline(row, data.figures.steps[row.ref], (row.template_ids ?? []).length)}
                standing={data.sequence.standing[row.ref] ?? 0}
                versions={data.figures.versions[row.ref]}
                followUp={row.step_type === "message" && messages.findIndex((message) => message.row.ref === row.ref) > 0}
                onSelect={() => onSelect(isSelected ? null : { ref: row.ref, what: "step" })}
                onNudge={(direction) => onChange(nudgeStep(doc, row.ref, direction))}
                onDragStart={() => setDragging(row.ref)}
                onDragEnd={() => { setDragging(null); setOver(null); }}
              />
              {item.gate ? (
                <>
                  <Connector />
                  <GateCard gate={item.gate} counts={data.sequence.gate_counts[row.ref]} titles={titles} data={data} selected={selected?.what === "gate" && selected.ref === row.ref} onSelect={() => onSelect({ ref: row.ref, what: "gate" })} />
                </>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="h-2.5" />
      {readOnly ? (
        steps === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-115 text-ink-3">No {track === "linkedin" ? "LinkedIn" : "email"} steps.</p> : null
      ) : (
        <div {...dropTarget("end")}>
          {over === "end" && dragging ? <div className="mb-1 h-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
          {track === "email" ? (
            <AddStep label="Add email step" onClick={() => add("email")} />
          ) : (
            <Menu align="start" width={280} trigger={<AddStep label="Add LinkedIn step" />}>
              {STEP_CHOICES.linkedin.map((choice) => (
                <MenuItem key={choice.type} icon={STEP_ICON[choice.type]} onSelect={() => add(choice.type)}>{choice.label}</MenuItem>
              ))}
            </Menu>
          )}
          {steps === 0 ? <p className="mt-2 text-center text-11 leading-4 text-ink-3">{track === "linkedin" ? "Visits, connection requests and messages go here." : "Emails go here. They can run beside LinkedIn or take over from it."}</p> : null}
        </div>
      )}
    </section>
  );
}

const Connector = () => <div className="ml-[23px] h-[9px] w-0.5 bg-line-strong" aria-hidden="true" />;

function AddStep({ label, ...props }: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button" {...props}
      className="flex h-[34px] w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-subtle text-115 font-medium text-ink-3 transition-colors hover:border-brand hover:bg-brand-tint hover:text-brand-strong focus-visible:border-brand"
    >
      <Plus size={13} aria-hidden="true" />
      {label}
    </button>
  );
}

function StepCard({
  item, track, selected, problems, readOnly, dragging, subline, standing, versions, followUp, onSelect, onNudge, onDragStart, onDragEnd,
}: {
  item: LaneItem; track: Track; selected: boolean; problems: string[]; readOnly: boolean; dragging: boolean; subline: string; standing: number;
  versions: BuilderData["figures"]["versions"][string] | undefined; followUp: boolean;
  onSelect: () => void; onNudge: (direction: -1 | 1) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const { row } = item;
  const Glyph = followUp ? MessageSquareDashed : STEP_ICON[row.step_type] ?? Mail;
  const title = stepTitle(item);
  const all = row.step_type === "email" ? versionsOf(row) : [];
  const shares = versionShares(all);
  const ahead = all.length > 1 ? leader(row, versions) : null;

  function onKey(event: KeyboardEvent) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }
  function onGripKey(event: KeyboardEvent) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    onNudge(event.key === "ArrowUp" ? -1 : 1);
  }

  return (
    <div
      role="button" tabIndex={0} aria-pressed={selected} aria-label={`${title}, day ${item.day}`}
      draggable={!readOnly}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.ref); onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onSelect} onKeyDown={onKey}
      className={cn(
        "flex cursor-pointer flex-col gap-[9px] rounded-lg border bg-surface p-2.5 shadow-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-tint",
        selected ? "border-brand ring-2 ring-brand-tint" : "border-line hover:border-line-strong",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className={cn("inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg", TINT[track])}><Glyph size={15} aria-hidden="true" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-125 font-semibold tracking-[-0.1px] text-ink">{title}</span>
          <span className="truncate text-105 text-ink-3">{subline}{standing > 0 ? ` · ${formatCount(standing)} here now` : ""}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {problems.length > 0 ? (
            <Tooltip label={<span className="flex flex-col gap-1">{problems.slice(0, 4).map((problem) => <span key={problem}>{problem}</span>)}</span>}>
              <span className="inline-flex text-warn" role="img" aria-label={`${problems.length} ${plural(problems.length, "thing", "things")} to fix`}><TriangleAlert size={14} aria-hidden="true" /></span>
            </Tooltip>
          ) : null}
          <span className={cn("inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-10 font-semibold uppercase", selected ? "bg-brand-tint text-brand-strong" : "bg-control text-ink-2")}>Day {item.day}</span>
          {readOnly ? null : (
            <button
              type="button" aria-label={`Move ${title}. Drag, or hold Alt and press the up or down arrow.`} title="Drag to reorder (Alt + ↑ / ↓)"
              onClick={(event) => event.stopPropagation()} onKeyDown={onGripKey}
              className="inline-flex cursor-grab rounded-sm text-ink-3 outline-none hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing"
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {all.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-10 font-semibold uppercase tracking-label text-ink-3">A/B</span>
          {all.map((version, index) => (
            <span key={index} className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] px-[7px]", index === 0 ? "bg-brand text-white" : "bg-control text-ink-2")}>
              <span className="text-105 font-semibold">{letter(index)}</span>
              <span className={cn("text-10 font-medium", index === 0 ? "text-white/70" : "text-ink-3")}>{shares[index]}%</span>
            </span>
          ))}
          {ahead ? <span className="text-105 font-semibold text-good">{letter(ahead.index)} leads</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function GateCard({
  gate, counts, titles, data, selected, onSelect,
}: {
  gate: Gate; counts: { true: number; false: number } | undefined; titles: Map<string, string>; data: BuilderData; selected: boolean; onSelect: () => void;
}) {
  const title = gateTitle(gate, data.custom_fields);
  return (
    <button
      type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Condition: ${title}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-surface p-2.5 text-left shadow-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-tint",
        selected ? "border-brand ring-2 ring-brand-tint" : "border-line-strong hover:border-ink-3",
      )}
    >
      <span className="flex items-center gap-2.5">
        <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand-strong"><GitBranch size={15} aria-hidden="true" /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-125 font-semibold tracking-[-0.1px] text-ink">{title}</span>
          <span className="truncate text-105 text-ink-3">{gateSubline(gate)}</span>
        </span>
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-control px-1.5 text-10 font-semibold text-ink-2">IF</span>
      </span>
      <span className="flex h-[26px] items-center justify-between gap-1.5 rounded-md bg-good-tint px-2">
        <span className="flex min-w-0 items-center gap-1.5 text-good">
          <CornerDownRight size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-11 font-medium">{outcomeLabel(gate.on_true, "true", gate, titles, data.lists)}</span>
        </span>
        <span className="shrink-0 text-105 font-semibold text-good">{formatCount(counts?.true ?? 0)}</span>
      </span>
      <span className="flex h-[26px] items-center justify-between gap-1.5 rounded-md bg-control px-2">
        <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
          <CornerDownLeft size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-11 font-medium">{outcomeLabel(gate.on_false, "false", gate, titles, data.lists)}</span>
        </span>
        <span className="shrink-0 text-105 font-semibold text-ink-3">{formatCount(counts?.false ?? 0)}</span>
      </span>
    </button>
  );
}

/** The pill between two steps. Clicking it changes how long the wait is, or takes it away. */
function WaitChip({ row, readOnly, removable, onSet }: { row: Row; readOnly: boolean; removable: boolean; onSet: (seconds: number) => void }) {
  const [open, setOpen] = useState(false);
  const total = Math.max(0, Number(row.delay_seconds) || 0);
  const [days, setDays] = useState("");
  const [hours, setHours] = useState("");
  const pill = "inline-flex h-5 w-fit items-center gap-[5px] rounded-lg border border-line-strong bg-surface px-2 text-105 font-semibold text-ink-2 shadow-card";
  const seconds = (Number(days) || 0) * DAY + (Number(hours) || 0) * HOUR;

  return (
    <div className="ml-[14px] flex flex-col">
      <div className="ml-[9px] h-[9px] w-0.5 bg-line-strong" aria-hidden="true" />
      {readOnly ? (
        <span className={pill}><Timer size={11} aria-hidden="true" />{waitLabel(total)}</span>
      ) : (
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) { setDays(String(Math.floor(total / DAY))); setHours(String(Math.round((total % DAY) / HOUR))); }
            setOpen(next);
          }}
          className="w-[236px]"
          trigger={<button type="button" className={cn(pill, "outline-none transition-colors hover:border-brand hover:text-brand-strong focus-visible:border-brand")}><Timer size={11} aria-hidden="true" />{waitLabel(total)}</button>}
        >
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (seconds > 0) { onSet(seconds); setOpen(false); }
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Days">{(id) => <Input id={id} inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))} data-autofocus />}</Field>
              <Field label="Hours">{(id) => <Input id={id} inputMode="numeric" value={hours} onChange={(event) => setHours(event.target.value.replace(/[^0-9]/g, "").slice(0, 2))} />}</Field>
            </div>
            <div className="flex items-center justify-between gap-2">
              {removable ? <Button size="sm" variant="ghost" icon={X} onClick={() => { onSet(0); setOpen(false); }}>Remove wait</Button> : <span className="text-105 text-ink-3">A condition sits on this wait</span>}
              <Button size="sm" variant="primary" type="submit" disabled={seconds <= 0}>Set</Button>
            </div>
          </form>
        </Popover>
      )}
      <div className="ml-[9px] h-[9px] w-0.5 bg-line-strong" aria-hidden="true" />
    </div>
  );
}
