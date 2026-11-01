import type { ReactNode } from "react";
import {useTranslations} from "next-intl";
import { Check, CornerDownLeft, CornerDownRight, GitBranch, ListPlus, Plus, SquareCheck, Trash2, X } from "lucide-react";
import { Button, Eyebrow, IconButton, Input, Menu, MenuItem, Segmented, Select, TextAction } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import {
  CONDITION_FIELDS, DEFAULT_OUTCOME, SIGNAL_TYPES, gateKindsFor, gateSubline, gateTitle, isNegative, isSending, laneItems, outcomeChoices, setGate, stepTitle,
  type BuilderData, type Doc, type Effect, type Gate, type GateKind, type Outcome, type OutcomeAction, type Row, type Track, type WorkflowCondition,
} from "./model";

const NUMBER_OPERATORS = [{ value: "gte", label: "is at least" }, { value: "gt", label: "is more than" }, { value: "lte", label: "is at most" }, { value: "lt", label: "is less than" }];
const TEXT_OPERATORS = [{ value: "is", label: "is" }, { value: "is_not", label: "is not" }, { value: "contains", label: "contains" }, { value: "exists", label: "is set" }, { value: "not_exists", label: "is not set" }, ...NUMBER_OPERATORS];

/**
 * The panel for the condition on a step: what is checked, and what happens to a contact on
 * each side. Changes go straight into the sequence being edited.
 */
export function GatePanel({
  doc, source, gate, track, data, readOnly, onChange, onApply, onCancel,
}: {
  doc: Doc;
  /** The step (or wait) the condition sits on. */
  source: Row;
  gate: Gate;
  track: Track;
  data: BuilderData;
  readOnly: boolean;
  onChange: (doc: Doc) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("SequenceGate");
  const update = (patch: Partial<Omit<Gate, "source">>) => onChange(setGate(doc, source.ref, { kind: gate.kind, conditions: gate.conditions, on_true: gate.on_true, on_false: gate.on_false, ...patch }));
  const items = laneItems(doc, track);
  const at = items.findIndex((item) => item.row.ref === source.ref);
  const later = items.slice(at + 1).filter((item) => isSending(item.row)).map((item) => ({ value: item.row.ref, label: `${stepTitle(item)} · ${t("day", {number: item.day ?? "—"})}` }));
  const counts = data.sequence.gate_counts[source.ref];
  const conditions = gate.conditions?.conditions ?? [];
  const fields = [
    ...CONDITION_FIELDS.map((field) => ({ value: field.field, label: field.label })),
    ...data.custom_fields.map((field) => ({ value: `custom.${field.key}`, label: field.name })),
  ];

  function setKind(kind: GateKind) {
    const keep = (outcome: Outcome, side: "true" | "false") => (outcomeChoices({ kind }, side, track, later.length).some((choice) => choice.value === outcome.then) ? outcome : { then: DEFAULT_OUTCOME[kind][side] });
    update({
      kind,
      conditions: kind === "conditions" ? gate.conditions ?? { mode: "all", conditions: [{ field: "replied", operator: "exists" }] } : undefined,
      on_true: keep(gate.on_true, "true"), on_false: keep(gate.on_false, "false"),
    });
  }
  const setConditions = (next: WorkflowCondition[]) => update({ conditions: { mode: gate.conditions?.mode ?? "all", conditions: next } });
  const setCondition = (index: number, next: WorkflowCondition) => setConditions(conditions.map((condition, position) => (position === index ? next : condition)));

  return (
    <aside aria-label={t("settings")} className="flex h-full w-[364px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2.5 border-b border-line bg-subtle px-3.5">
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-tint text-brand-strong"><GitBranch size={14} aria-hidden="true" /></span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-13 font-semibold tracking-[-0.1px] text-ink">{gateTitle(gate, data.custom_fields)}</h2>
            <p className="truncate text-105 text-ink-3">{t("condition")} · {gateSubline(gate)}</p>
          </div>
        </div>
        <IconButton icon={X} label={t("close")} size={28} onClick={onApply} />
      </header>

      <fieldset disabled={readOnly} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <div className="flex gap-2 rounded-lg bg-subtle p-2.5">
          <Figure label={t("wentTrue")} value={formatCount(counts?.true ?? 0)} tone="text-good" />
          <Figure label={t("wentFalse")} value={formatCount(counts?.false ?? 0)} tone="text-ink" />
        </div>

        <Block label={t("check")}>
          <Select className="w-full" label={t("check")} value={gate.kind} onChange={setKind} options={gateKindsFor(source).map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))} />
          <p className="text-11 leading-4 text-ink-2">{t(`help.${gate.kind}`)}</p>
        </Block>

        {gate.kind === "conditions" ? (
          <Block label={t("conditions")} aside={conditions.length > 1 ? (
            <Segmented size="sm" label={t("combine")} value={gate.conditions?.mode ?? "all"} onChange={(mode) => update({ conditions: { mode, conditions } })} options={[{ value: "all", label: t("all") }, { value: "any", label: t("any") }]} />
          ) : undefined}>
            {conditions.length === 0 ? <p className="text-11 leading-4 text-warn">{t("emptyConditions")}</p> : null}
            {conditions.map((condition, index) => (
              <ConditionRow key={index} condition={condition} fields={fields} readOnly={readOnly} onChange={(next) => setCondition(index, next)} onRemove={() => setConditions(conditions.filter((_, position) => position !== index))} />
            ))}
            {readOnly || conditions.length >= 6 ? null : <Button size="sm" icon={Plus} className="self-start" onClick={() => setConditions([...conditions, { field: "replied", operator: "exists" }])}>{t("add")}</Button>}
          </Block>
        ) : null}

        <OutcomeBlock side="true" label={t(`sides.${gate.kind}.yes`)} outcome={gate.on_true} gate={gate} track={track} later={later} lists={data.lists} readOnly={readOnly} onChange={(outcome) => update({ on_true: outcome })} />
        <OutcomeBlock side="false" label={t(`sides.${gate.kind}.no`)} outcome={gate.on_false} gate={gate} track={track} later={later} lists={data.lists} readOnly={readOnly} onChange={(outcome) => update({ on_false: outcome })} />
      </fieldset>

      {readOnly ? null : (
        <footer className="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-line bg-subtle px-3.5">
          <Button variant="ghost" icon={Trash2} onClick={() => { onChange(setGate(doc, source.ref, null)); onApply(); }} className="text-bad hover:bg-bad-tint hover:text-bad">{t("remove")}</Button>
          <div className="flex items-center gap-2">
            <Button onClick={onCancel}>{t("cancel")}</Button>
            <Button variant="primary" icon={Check} onClick={onApply}>{t("apply")}</Button>
          </div>
        </footer>
      )}
    </aside>
  );
}


function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span className="text-95 font-semibold uppercase tracking-label text-ink-3">{label}</span>
      <span className={cn("text-14 font-semibold tracking-[-0.3px]", tone)}>{value}</span>
    </div>
  );
}

function Block({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-4 items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ConditionRow({
  condition, fields, readOnly, onChange, onRemove,
}: {
  condition: WorkflowCondition; fields: Array<{ value: string; label: string }>; readOnly: boolean; onChange: (condition: WorkflowCondition) => void; onRemove: () => void;
}) {
  const t = useTranslations("SequenceGate");
  const operatorLabels: Record<string, string> = {gte:t("operators.gte"), gt:t("operators.gt"), lte:t("operators.lte"), lt:t("operators.lt"), is:t("operators.is"), is_not:t("operators.is_not"), contains:t("operators.contains"), exists:t("operators.exists"), not_exists:t("operators.not_exists")};
  const known = CONDITION_FIELDS.find((field) => field.field === condition.field);
  const type = known?.type ?? "text";
  const valueless = condition.operator === "exists" || condition.operator === "not_exists";

  function setField(field: string) {
    const next = CONDITION_FIELDS.find((candidate) => candidate.field === field)?.type ?? "text";
    if (next === "yes_no") onChange({ field, operator: "exists" });
    else if (next === "number") onChange({ field, operator: "gte", value: 70 });
    else if (next === "signal") onChange({ field, operator: "exists", value: "job_change" });
    else onChange({ field, operator: "exists" });
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line p-2">
      <div className="flex items-center gap-1.5">
        <Select className="min-w-0 flex-1" label={t("conditionRow.field")} value={fields.some((field) => field.value === condition.field) ? condition.field : undefined} placeholder={condition.field} onChange={setField} options={fields} />
        {readOnly ? null : <IconButton icon={X} label={t("conditionRow.remove")} size={24} onClick={onRemove} />}
      </div>
      {type === "yes_no" ? (
        <Segmented size="sm" label={t("conditionRow.boolean")} value={isNegative(condition) ? "no" : "yes"} onChange={(value) => onChange({ field: condition.field, operator: value === "no" ? "not_exists" : "exists" })} options={[{ value: "yes", label: t("conditionRow.yes") }, { value: "no", label: t("conditionRow.no") }]} />
      ) : type === "signal" ? (
        <Select className="w-full" label={t("conditionRow.signal")} value={String(condition.value ?? "custom")} onChange={(value) => onChange({ field: condition.field, operator: "exists", value })} options={SIGNAL_TYPES} />
      ) : (
        <div className="flex items-center gap-1.5">
          <Select
            className="min-w-0 flex-1" label={t("conditionRow.compare")} value={condition.operator}
            onChange={(operator) => onChange({ field: condition.field, operator: operator as WorkflowCondition["operator"], ...(operator === "exists" || operator === "not_exists" ? {} : { value: condition.value ?? "" }) })}
            options={(type === "number" ? NUMBER_OPERATORS : TEXT_OPERATORS).map(operator => ({...operator, label: operatorLabels[operator.value]}))}
          />
          {valueless ? null : (
            <Input
              frameClassName="w-[110px] shrink-0" aria-label={t("conditionRow.value")} value={condition.value == null ? "" : String(condition.value)} inputMode={type === "number" ? "numeric" : undefined}
              onChange={(event) => onChange({ ...condition, value: type === "number" ? (event.target.value === "" ? "" : Number(event.target.value.replace(/[^0-9.]/g, ""))) : event.target.value })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OutcomeBlock({
  side, label, outcome, gate, track, later, lists, readOnly, onChange,
}: {
  side: "true" | "false"; label: string; outcome: Outcome; gate: Gate; track: Track; later: Array<{ value: string; label: string }>; lists: BuilderData["lists"]; readOnly: boolean; onChange: (outcome: Outcome) => void;
}) {
  const t = useTranslations("SequenceGate");
  const choices = outcomeChoices(gate, side, track, later.length);
  const effects = outcome.effects ?? [];
  const setEffects = (next: Effect[]) => onChange({ ...outcome, effects: next });
  const setEffect = (index: number, next: Effect) => setEffects(effects.map((effect, position) => (position === index ? next : effect)));
  const Arrow = side === "true" ? CornerDownRight : CornerDownLeft;

  return (
    <section className={cn("flex flex-col gap-2 rounded-lg p-2.5", side === "true" ? "bg-good-tint" : "bg-subtle")}>
      <div className={cn("flex items-center gap-1.5 text-115 font-semibold", side === "true" ? "text-good" : "text-ink-2")}><Arrow size={13} aria-hidden="true" />{label}</div>
      <Select
        className="w-full" label={t("outcome.action", {label})} value={outcome.then} disabled={choices.length === 1}
        onChange={(then: OutcomeAction) => onChange({ ...outcome, then, step: then === "jump" ? later[0]?.value ?? null : null })} options={choices}
      />
      {outcome.then === "jump" ? (
        <Select className="w-full" label={t("outcome.jump")} value={later.some((step) => step.value === outcome.step) ? outcome.step ?? undefined : undefined} placeholder={t("outcome.chooseLater")} onChange={(step) => onChange({ ...outcome, step })} options={later} />
      ) : null}
      {effects.map((effect, index) => (
        <div key={index} className="flex items-center gap-1.5">
          {effect.type === "add_to_list" ? (
            <>
              <ListPlus size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
              <Select className="min-w-0 flex-1" label={t("outcome.addToList")} value={lists.some((list) => list.id === effect.list_id) ? effect.list_id : undefined} placeholder={t("outcome.chooseList")} onChange={(list_id) => setEffect(index, { type: "add_to_list", list_id })} options={lists.map((list) => ({ value: list.id, label: list.name }))} />
            </>
          ) : (
            <>
              <SquareCheck size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
              <Input frameClassName="min-w-0 flex-1" aria-label={t("outcome.task")} value={effect.title} placeholder="Call {{first_name}} at {{company}}" maxLength={200} onChange={(event) => setEffect(index, { ...effect, title: event.target.value })} />
            </>
          )}
          {readOnly ? null : <IconButton icon={X} label={t("outcome.remove")} size={24} onClick={() => setEffects(effects.filter((_, position) => position !== index))} />}
        </div>
      ))}
      {readOnly || effects.length >= 5 ? null : (
        <Menu align="start" width={220} trigger={<TextAction className="self-start">{t("outcome.also")}</TextAction>}>
          <MenuItem icon={ListPlus} disabled={lists.length === 0} onSelect={() => setEffects([...effects, { type: "add_to_list", list_id: lists[0]?.id ?? "" }])}>{t("outcome.addContact")}</MenuItem>
          <MenuItem icon={SquareCheck} onSelect={() => setEffects([...effects, { type: "create_task", title: "Follow up with {{first_name}}" }])}>{t("outcome.createTask")}</MenuItem>
        </Menu>
      )}
    </section>
  );
}
