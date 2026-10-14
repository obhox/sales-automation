import { useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, Check, ChevronDown, Eye, FileText, GitBranch, Mail, MessageSquare, Minus, PenLine, Plus, Send, SendHorizontal, Sparkles, Split, Trash2, UserPlus, X } from "lucide-react";
import { DaysField, HoursField } from "@/components/linkedin-accounts/SettingsFields";
import { daysSummary, hourLabel } from "@/components/linkedin-accounts/model";
import { Button, Checkbox, Eyebrow, IconButton, Input, Popover, Select, Switch, TextAction, Textarea, type Icon } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatPercent, plural } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { MessageEditor } from "./MessageEditor";
import {
  AI_LANGUAGES, CONNECT_NOTE_LIMIT, DAY, HOUR, MAX_VERSIONS, STEP_KIND_LABEL, gateOn, leader, letter, mergeTags, performance, setWaitBefore, splitLabel, stepProblems, stepTitle,
  updateRow, versionShares, versionsOf, waitBefore,
  type BuilderData, type Doc, type LaneItem, type Row, type StepInput, type Track, type VariantInput,
} from "./model";

const STEP_ICON: Record<string, Icon> = { visit: Eye, connect: UserPlus, message: MessageSquare, sales_inmail: Send, email: Mail };
const TONE_TEXT = { li: "text-li", mail: "text-mail", warn: "text-warn" } as const;
const isOn = (value: unknown) => value === true || value === 1;

/**
 * The panel beside the canvas for the step that is selected. Every change goes straight
 * into the sequence being edited; Cancel puts the step back as it was when the panel
 * opened, and Apply simply closes it.
 */
export function StepPanel({
  doc, item, track, data, workflowId, readOnly, onChange, onApply, onCancel, onDelete, onGate, onTest,
}: {
  doc: Doc;
  item: LaneItem;
  track: Track;
  data: BuilderData;
  workflowId: string;
  readOnly: boolean;
  onChange: (doc: Doc) => void;
  onApply: () => void;
  onCancel: () => void;
  onDelete: () => void;
  /** Open the condition on this step, adding one if there is none. */
  onGate: () => void;
  /** Send this email, as the version being edited, to yourself. */
  onTest: (pick: number) => void;
}) {
  const { row } = item;
  const [version, setVersion] = useState(0);
  const set = (patch: Partial<StepInput>) => onChange(updateRow(doc, row.ref, patch));
  const Glyph = STEP_ICON[row.step_type] ?? Mail;
  const versions = row.step_type === "email" ? versionsOf(row) : [];
  const shown = Math.min(version, Math.max(0, versions.length - 1));
  const figures = data.figures.steps[row.ref];
  const customKeys = data.custom_fields.map((field) => field.key);
  const problems = stepProblems(row, data.templates, customKeys);
  const channel = row.step_type === "email" ? "email" : "linkedin";
  const pool = (row.template_ids ?? []).filter((id) => data.templates.some((template) => template.id === id && template.channel === channel));
  const usesPool = pool.length > 0;
  const usesAi = isOn(row.ai_enabled);
  const writes = row.step_type === "message" || row.step_type === "sales_inmail" || row.step_type === "email";
  const hasGate = Boolean(gateOn(doc, row.ref));

  return (
    <aside aria-label="Step settings" className="flex h-full w-[364px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2.5 border-b border-line bg-subtle px-3.5">
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md", track === "email" ? "bg-mail-tint text-mail" : "bg-li-tint text-li")}><Glyph size={14} aria-hidden="true" /></span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-13 font-semibold tracking-[-0.1px] text-ink">{stepTitle(item)}</h2>
            <p className="truncate text-105 text-ink-3">{STEP_KIND_LABEL[row.step_type]} · Day {item.day}{versions.length > 1 ? ` · ${versions.length} versions` : ""}</p>
          </div>
        </div>
        <IconButton icon={X} label="Close step settings" size={28} onClick={onApply} />
      </header>

      <fieldset disabled={readOnly} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <div className="flex gap-2 rounded-lg bg-subtle p-2.5">
          {performance(row, figures).map((figure) => (
            <div key={figure.label} className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-95 font-semibold uppercase tracking-label text-ink-3">{figure.label}</span>
              <span className={cn("text-14 font-semibold tracking-[-0.3px]", figure.tone ? TONE_TEXT[figure.tone] : "text-ink")}>{figure.value}</span>
            </div>
          ))}
        </div>

        {problems.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-lg bg-warn-tint px-2.5 py-2 text-11 leading-4 text-warn">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        ) : null}

        <DelaySection doc={doc} row={row} first={item.day === 1 && !waitBefore(doc, row.ref)} onChange={onChange} set={set} readOnly={readOnly} />

        {row.step_type === "connect" ? (
          <MessageEditor
            label="Note" body={row.connect_note ?? ""} onBody={(value) => set({ connect_note: value })} limit={CONNECT_NOTE_LIMIT} rows={5} disabled={readOnly}
            tags={mergeTags(data.custom_fields)} placeholder="Leave empty to send the request without a note."
            rewrite={{ channel: "connect_note", workflowId, ready: data.ai.has_key && Boolean(data.ai.default_model) }}
          />
        ) : null}

        {row.step_type === "email" ? (
          <VersionsSection row={row} shown={shown} figures={data.figures.versions[row.ref]} readOnly={readOnly} onShow={setVersion} set={set} />
        ) : null}

        {writes ? (
          <>
            {usesAi || usesPool ? (
              <p className="rounded-md bg-brand-tint px-2.5 py-1.5 text-11 leading-4 text-brand-strong">
                {usesAi ? "AI writes this step for each contact when it is sent." : `Each contact gets one of the ${pool.length} ${plural(pool.length, "template", "templates")} below.`} The text here is kept, and not sent.
              </p>
            ) : null}
            {row.step_type === "email" ? (
              <MessageEditor
                key={shown} label="Message body" aside={versions.length > 1 ? `Version ${letter(shown)}` : undefined} disabled={readOnly}
                subject={versions[shown].subject} subjectPlaceholder={isOn(row.email_in_thread) ? "Sent as a reply: keeps the first email's subject" : "{{company}} + a reason to open"}
                onSubject={(value) => setVersionText(row, shown, { subject: value }, set)}
                body={versions[shown].body} onBody={(value) => setVersionText(row, shown, { body: value }, set)}
                tags={mergeTags(data.custom_fields, { email: true })}
                rewrite={{ channel: "email", workflowId, ready: data.ai.has_key && Boolean(data.ai.default_model) }}
              />
            ) : (
              <MessageEditor
                label="Message body" disabled={readOnly} tags={mergeTags(data.custom_fields)}
                subject={row.step_type === "sales_inmail" ? row.email_subject ?? "" : undefined} onSubject={row.step_type === "sales_inmail" ? (value) => set({ email_subject: value }) : undefined}
                subjectPlaceholder="A subject for the InMail"
                body={row.message_body ?? ""} onBody={(value) => set({ message_body: value })}
                rewrite={{ channel: "linkedin", workflowId, ready: data.ai.has_key && Boolean(data.ai.default_model) }}
              />
            )}
            <TemplatePool row={row} channel={channel} templates={data.templates} readOnly={readOnly} set={set} />
          </>
        ) : null}

        {row.step_type === "email" ? (
          <>
            <Section label="Signature override">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {row.email_signature != null ? (
                    <Textarea rows={3} value={row.email_signature} onChange={(event) => set({ email_signature: event.target.value })} aria-label="Signature for this step" placeholder="Leave empty to send this step with no signature." className="text-115" />
                  ) : (
                    <div className="flex h-8 items-center gap-[7px] rounded-md border border-line bg-surface px-2.5 text-115 font-medium text-ink-2"><PenLine size={13} className="shrink-0 text-ink-3" aria-hidden="true" />The mailbox&apos;s own signature</div>
                  )}
                </div>
                <Switch checked={row.email_signature != null} onChange={(on) => set({ email_signature: on ? "" : null })} label="Use a different signature for this step" className="mt-2" />
              </div>
            </Section>
            <Section label="Delivery">
              <Row label="Send as a reply in the same thread" hint={item.number === 1 ? "The first email starts the thread." : "Lands in the conversation your earlier email started."}>
                <Switch checked={item.number > 1 && isOn(row.email_in_thread)} disabled={item.number === 1} onChange={(on) => set({ email_in_thread: on ? 1 : 0 })} label="Send as a reply in the same thread" />
              </Row>
              <Row label="Rich format, with tracking" hint="Plain text sends no links and tracks nothing, which is kindest to deliverability.">
                <Switch checked={row.email_delivery_mode === "enhanced"} onChange={(on) => set(on ? { email_delivery_mode: "enhanced" } : { email_delivery_mode: "plain", email_track_opens: 0, email_track_clicks: 0 })} label="Rich format, with tracking" />
              </Row>
              {row.email_delivery_mode === "enhanced" ? (
                <div className="flex gap-4 pl-0.5">
                  <label className="flex items-center gap-1.5 text-115 text-ink-2"><Checkbox checked={isOn(row.email_track_opens)} onChange={(on) => set({ email_track_opens: on ? 1 : 0 })} label="Track opens" />Track opens</label>
                  <label className="flex items-center gap-1.5 text-115 text-ink-2"><Checkbox checked={isOn(row.email_track_clicks)} onChange={(on) => set({ email_track_clicks: on ? 1 : 0 })} label="Track clicks" />Track clicks</label>
                </div>
              ) : null}
            </Section>
          </>
        ) : null}

        {writes && data.ai.available ? <AiSection row={row} ai={data.ai} set={set} onTry={readOnly ? undefined : () => onTest(0)} /> : null}

        {readOnly ? null : (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <Button size="sm" icon={GitBranch} onClick={onGate}>{hasGate ? "Edit the condition" : "Add a condition"}</Button>
            {row.step_type === "email" ? <Button size="sm" icon={SendHorizontal} onClick={() => onTest(shown)}>{usesAi ? "Write a sample and send a test" : "Send a test"}</Button> : null}
          </div>
        )}
      </fieldset>

      {readOnly ? null : (
        <footer className="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-line bg-subtle px-3.5">
          <Button variant="ghost" icon={Trash2} onClick={onDelete} className="text-bad hover:bg-bad-tint hover:text-bad">Delete step</Button>
          <div className="flex items-center gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" icon={Check} onClick={onApply}>Apply to step</Button>
          </div>
        </footer>
      )}
    </aside>
  );
}

function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-4 items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {aside ? <span className="text-10 font-medium text-ink-3">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-115 text-ink">{label}</span>
        {hint ? <span className="text-105 leading-[14px] text-ink-3">{hint}</span> : null}
      </div>
      <div className="mt-0.5 shrink-0">{children}</div>
    </div>
  );
}

/** How long to wait before the step, and the hours and days it may go out in. */
function DelaySection({ doc, row, first, readOnly, onChange, set }: { doc: Doc; row: Row; first: boolean; readOnly: boolean; onChange: (doc: Doc) => void; set: (patch: Partial<StepInput>) => void }) {
  const seconds = Math.max(0, Number(waitBefore(doc, row.ref)?.delay_seconds) || 0);
  const [unit, setUnit] = useState<"days" | "hours">(seconds > 0 && seconds % DAY !== 0 ? "hours" : "days");
  const [editingWindow, setEditingWindow] = useState(false);
  const size = unit === "days" ? DAY : HOUR;
  const amount = Math.round(seconds / size);
  const setAmount = (next: number) => onChange(setWaitBefore(doc, row.ref, Math.max(0, Math.min(next, unit === "days" ? 365 : 24 * 30)) * size));
  const hasHours = row.window_start != null && row.window_end != null;
  const hasDays = Boolean(row.window_days);
  const windowText = hasHours || hasDays
    ? [hasDays ? daysSummary(String(row.window_days)) : "The sender's days", hasHours ? `${hourLabel(row.window_start as number)}–${hourLabel(row.window_end as number)}` : "the sender's hours"].join(" · ")
    : "The sender's own hours and days";
  const stepper = "inline-flex h-[30px] w-7 items-center justify-center text-ink-2 outline-none hover:bg-subtle focus-visible:bg-brand-tint disabled:opacity-40";

  return (
    <Section label={unit === "days" ? "Day delay" : "Delay"}>
      <div className="flex items-center gap-2">
        <div className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-line-strong bg-surface">
          <button type="button" aria-label="Wait less" className={stepper} disabled={amount <= 0} onClick={() => setAmount(amount - 1)}><Minus size={13} aria-hidden="true" /></button>
          <span className="h-[30px] w-px bg-line" aria-hidden="true" />
          <input
            aria-label={`Wait before this step, in ${unit}`} inputMode="numeric" value={String(amount)}
            onChange={(event) => setAmount(Number(event.target.value.replace(/[^0-9]/g, "").slice(0, 3)) || 0)}
            className="h-[30px] w-[38px] bg-transparent text-center text-125 font-semibold text-ink outline-none focus-visible:bg-brand-tint"
          />
          <span className="h-[30px] w-px bg-line" aria-hidden="true" />
          <button type="button" aria-label="Wait more" className={stepper} onClick={() => setAmount(amount + 1)}><Plus size={13} aria-hidden="true" /></button>
        </div>
        <Select size="md" label="Unit of the wait" value={unit} onChange={(value) => { setUnit(value); onChange(setWaitBefore(doc, row.ref, amount * (value === "days" ? DAY : HOUR))); }} options={[{ value: "days", label: amount === 1 ? "day" : "days" }, { value: "hours", label: amount === 1 ? "hour" : "hours" }]} />
        <span className="min-w-0 flex-1 text-115 leading-4 text-ink-2">{first ? "after the track starts" : "after the step before"}</span>
      </div>
      <div className="flex min-h-7 items-center justify-between gap-1.5 rounded-md bg-subtle px-[9px] py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-11 text-ink-2"><CalendarClock size={12} className="shrink-0" aria-hidden="true" /><span className="truncate">{windowText}</span></span>
        {readOnly ? null : <TextAction onClick={() => setEditingWindow(!editingWindow)}>{editingWindow ? "Done" : "Edit"}</TextAction>}
      </div>
      {editingWindow ? (
        <div className="flex flex-col gap-2.5 rounded-md border border-line p-2.5">
          <p className="text-105 leading-[14px] text-ink-3">A window narrows when this one step may go out. It never widens the sender&apos;s own hours.</p>
          <HoursField start={hasHours ? (row.window_start as number) : 9} end={hasHours ? (row.window_end as number) : 17} onChange={(start, end) => set({ window_start: start, window_end: end })} />
          <DaysField value={hasDays ? String(row.window_days) : "1,2,3,4,5"} onChange={(value) => set({ window_days: value })} />
          {hasHours || hasDays ? <TextAction className="self-start" onClick={() => set({ window_start: null, window_end: null, window_days: null })}>Use the sender&apos;s own hours and days</TextAction> : null}
        </div>
      ) : null}
    </Section>
  );
}

/** Write one version's subject or body: A is the step's own text, the rest live in its variants. */
function setVersionText(row: Row, index: number, change: { subject?: string; body?: string }, set: (patch: Partial<StepInput>) => void) {
  if (index === 0) {
    set({ ...(change.subject !== undefined ? { email_subject: change.subject } : {}), ...(change.body !== undefined ? { email_body: change.body } : {}) });
    return;
  }
  set({ email_variants: (row.email_variants ?? []).map((variant, position) => (position === index - 1 ? { ...variant, ...change } : variant)) });
}

function VersionsSection({
  row, shown, figures, readOnly, onShow, set,
}: {
  row: Row; shown: number; figures: BuilderData["figures"]["versions"][string] | undefined; readOnly: boolean; onShow: (index: number) => void; set: (patch: Partial<StepInput>) => void;
}) {
  const versions = versionsOf(row);
  const [editingSplit, setEditingSplit] = useState(false);
  const ahead = versions.length > 1 ? leader(row, figures) : null;
  const shares = versionShares(versions);

  function add() {
    // A new version starts as a copy of the one being looked at, ready to be changed.
    const copy: VariantInput = { id: null, subject: versions[shown].subject, body: versions[shown].body, weight: null };
    set({ email_variants: [...(row.email_variants ?? []), copy] });
    onShow(versions.length);
  }
  function remove(index: number) {
    set({ email_variants: (row.email_variants ?? []).filter((_, position) => position !== index - 1) });
    onShow(Math.max(0, index - 1));
  }
  function setWeight(index: number, text: string) {
    const weight = text === "" ? null : Math.max(1, Math.min(100, Number(text)));
    if (index === 0) set({ email_control_weight: weight });
    else set({ email_variants: (row.email_variants ?? []).map((variant, position) => (position === index - 1 ? { ...variant, weight } : variant)) });
  }

  return (
    <Section label="A/B variants" aside={`${versions.length} of ${MAX_VERSIONS} used`}>
      <div role="tablist" aria-label="Versions of this email" className="flex h-[30px] gap-0.5 rounded-lg bg-control p-0.5">
        {versions.map((version) => (
          <button
            key={version.index} type="button" role="tab" aria-selected={version.index === shown} onClick={() => onShow(version.index)}
            className={cn("inline-flex h-[26px] min-w-0 flex-1 items-center justify-center gap-[5px] rounded-md text-11 outline-none focus-visible:ring-2 focus-visible:ring-brand", version.index === shown ? "bg-surface font-semibold text-ink shadow-seg" : "font-medium text-ink-2 hover:text-ink")}
          >
            <span className="truncate">Variant {letter(version.index)}</span>
            {ahead?.index === version.index ? <span className="size-1.5 shrink-0 rounded-full bg-good" role="img" aria-label="Leading" /> : null}
          </button>
        ))}
        {versions.length < MAX_VERSIONS && !readOnly ? (
          <button type="button" onClick={add} aria-label="Add a version" title="Add a version" className="inline-flex h-[26px] w-8 shrink-0 items-center justify-center rounded-md text-ink-2 outline-none hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"><Plus size={13} aria-hidden="true" /></button>
        ) : null}
      </div>
      {versions.length > 1 ? (
        <>
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-11 text-ink-2"><Split size={12} className="shrink-0" aria-hidden="true" /><span className="truncate">{splitLabel(versions)}</span></span>
            <span className="flex shrink-0 items-center gap-2.5">
              {ahead ? <span className="text-11 font-semibold text-good">{letter(ahead.index)} leads at {formatPercent(ahead.rate)} reply</span> : null}
              {readOnly ? null : <TextAction onClick={() => setEditingSplit(!editingSplit)}>{editingSplit ? "Done" : "Edit split"}</TextAction>}
            </span>
          </div>
          {editingSplit ? (
            <div className="flex flex-col gap-2 rounded-md border border-line p-2.5">
              <p className="text-105 leading-[14px] text-ink-3">Give each version a weight. A version with twice the weight goes to twice as many contacts. Leave them all empty for equal shares.</p>
              <div className="grid grid-cols-4 gap-2">
                {versions.map((entry) => (
                  <label key={entry.index} className="flex flex-col gap-1 text-105 font-semibold text-ink-2">
                    {letter(entry.index)} · {shares[entry.index]}%
                    <Input inputMode="numeric" value={entry.weight == null ? "" : String(entry.weight)} placeholder="1" onChange={(event) => setWeight(entry.index, event.target.value.replace(/[^0-9]/g, "").slice(0, 3))} aria-label={`Weight of version ${letter(entry.index)}`} />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {shown > 0 && !readOnly ? <TextAction className="self-start text-bad" onClick={() => remove(shown)}>Remove version {letter(shown)}</TextAction> : null}
        </>
      ) : null}
    </Section>
  );
}

/** The templates a step rotates through, in place of its own text. */
function TemplatePool({ row, channel, templates, readOnly, set }: { row: Row; channel: "linkedin" | "email"; templates: BuilderData["templates"]; readOnly: boolean; set: (patch: Partial<StepInput>) => void }) {
  const available = templates.filter((template) => template.channel === channel);
  // A single template chosen in the old editor counts as a pool of one.
  const chosen = (row.template_ids ?? []).length ? row.template_ids ?? [] : channel === "linkedin" && row.template_id ? [row.template_id] : [];
  const picked = available.filter((template) => chosen.includes(template.id));
  const categories = [...new Set(available.map((template) => template.category ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const oneCategory = picked.length > 0 && new Set(picked.map((template) => template.category ?? "")).size === 1 ? picked[0].category : null;
  const wholeCategory = oneCategory && picked.length === available.filter((template) => template.category === oneCategory).length;
  const summary = picked.length === 0 ? "No templates chosen" : wholeCategory ? `${oneCategory} · ${picked.length} ${plural(picked.length, "template", "templates")}` : picked.length === 1 ? picked[0].name : `${picked.length} templates`;
  const choose = (ids: string[]) => set({ template_ids: available.filter((template) => ids.includes(template.id)).map((template) => template.id), template_id: null });
  const toggle = (id: string, on: boolean) => choose(on ? [...chosen, id] : chosen.filter((other) => other !== id));

  return (
    <Section label="Template pool">
      {available.length === 0 ? (
        <p className="text-11 leading-4 text-ink-3">
          No {channel === "email" ? "email" : "LinkedIn"} templates yet. <Link href={recordHref("template", "")} className="font-semibold text-brand-strong hover:underline">Add some under Templates</Link> to rotate wording across contacts.
        </p>
      ) : (
        <>
          <Popover
            align="start" className="max-h-[320px] w-[334px] overflow-y-auto p-2"
            trigger={
              <button type="button" disabled={readOnly} className="flex h-8 w-full items-center justify-between gap-[7px] rounded-md border border-line-strong bg-surface px-2.5 text-left outline-none hover:bg-subtle focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand-tint disabled:opacity-60">
                <span className="flex min-w-0 items-center gap-[7px]"><FileText size={13} className="shrink-0 text-ink-3" aria-hidden="true" /><span className={cn("truncate text-115 font-medium", picked.length ? "text-ink" : "text-ink-3")}>{summary}</span></span>
                <ChevronDown size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
              </button>
            }
          >
            <div className="flex flex-col gap-2">
              {categories.map((category) => {
                const inCategory = available.filter((template) => (template.category ?? "") === category);
                const all = inCategory.every((template) => chosen.includes(template.id));
                return (
                  <div key={category || "none"} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between px-1.5 pt-1">
                      <Eyebrow>{category || "No category"}</Eyebrow>
                      <TextAction onClick={() => choose(all ? chosen.filter((id) => !inCategory.some((template) => template.id === id)) : [...chosen, ...inCategory.map((template) => template.id)])}>{all ? "Clear" : "Use all"}</TextAction>
                    </div>
                    {inCategory.map((template) => (
                      <label key={template.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle">
                        <Checkbox checked={chosen.includes(template.id)} onChange={(on) => toggle(template.id, on)} label={`Use ${template.name}`} className="mt-0.5" />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-115 font-medium text-ink">{template.name}</span>
                          <span className="line-clamp-1 text-105 text-ink-3">{template.subject ? `${template.subject} — ` : ""}{template.body}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </Popover>
          <div className="flex min-h-[22px] items-center justify-between gap-3">
            <span className="text-115 text-ink-2">Rotate templates per prospect</span>
            <Switch checked={picked.length > 0} disabled={readOnly} label="Rotate templates per prospect" onChange={(on) => choose(on ? available.filter((template) => !oneCategory || template.category === oneCategory).map((template) => template.id) : [])} />
          </div>
          {picked.length > 0 ? <p className="text-105 leading-[14px] text-ink-3">Each contact is given one of these, chosen once and kept{channel === "email" ? ". A template with no subject goes out under this step's subject" : ""}.</p> : null}
        </>
      )}
    </Section>
  );
}

function AiSection({ row, ai, set, onTry }: { row: Row; ai: BuilderData["ai"]; set: (patch: Partial<StepInput>) => void; onTry?: () => void }) {
  const on = isOn(row.ai_enabled);
  const ready = ai.has_key && Boolean(row.ai_model || ai.default_model);
  return (
    <Section label="AI writer">
      <Row label="Let AI write this step" hint="A message of its own for each contact, written from their profile and company when the step is sent.">
        <Switch checked={on} onChange={(next) => set({ ai_enabled: next ? 1 : 0, ...(next && !row.ai_language ? { ai_language: "English" } : {}) })} label="Let AI write this step" />
      </Row>
      {on ? (
        <div className="flex flex-col gap-2.5">
          {!ready ? <p className="rounded-md bg-warn-tint px-2.5 py-1.5 text-11 leading-4 text-warn">{ai.has_key ? "Choose a model here or a default under AI & models, or this step is skipped." : "Add an OpenRouter key under AI & models, or this step is skipped."}</p> : null}
          <Textarea rows={4} value={row.ai_prompt ?? ""} onChange={(event) => set({ ai_prompt: event.target.value })} aria-label="What this step should say" placeholder="What should this step say? For example: open with their recent funding round, then ask for 15 minutes." className="text-115" />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5 text-105 font-semibold text-ink-2">
              Model
              <Input value={row.ai_model ?? ""} onChange={(event) => set({ ai_model: event.target.value.trim() || null })} placeholder={ai.default_model ?? "provider/model"} aria-label="Model for this step" />
            </label>
            <label className="flex flex-col gap-1.5 text-105 font-semibold text-ink-2">
              Longest, in words
              <Input inputMode="numeric" value={row.ai_max_words ? String(row.ai_max_words) : ""} onChange={(event) => set({ ai_max_words: Number(event.target.value.replace(/[^0-9]/g, "").slice(0, 4)) || null })} placeholder="No limit" aria-label="Longest message, in words" />
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-105 font-semibold text-ink-2">
            Language
            <Select className="w-full" value={row.ai_language ?? "English"} onChange={(value) => set({ ai_language: value })} options={AI_LANGUAGES.map((language) => ({ value: language, label: language }))} label="Language" />
          </label>
          {onTry ? (
            <div className="flex flex-col items-start gap-1.5">
              <Button size="sm" icon={Sparkles} disabled={!ready || !(row.ai_prompt ?? "").trim()} onClick={onTry}>Write a sample</Button>
              <p className="text-105 leading-[14px] text-ink-3">See what this writes for one contact, with the instruction above as it is now. It counts towards this month&apos;s AI spend.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
