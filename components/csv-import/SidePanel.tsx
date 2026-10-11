import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Copy, Download, ListChecks, RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, Button, Card, Checkbox, Drawer, Eyebrow, Input, OptionPicker, Segmented, Select, Spinner, TextAction, Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount, formatRelative } from "@/lib/client/format";
import {
  AFTER_NEW, AFTER_NONE, ON_DUPLICATE_HINT, ON_DUPLICATE_OPTIONS, TEMPLATE_PATH, afterChoice, afterFrom, afterOptions, duplicateNote, issueText, listLine, matchCount, validationFigures,
  type ImportCheck, type ImportView, type Issue,
} from "./model";
import { PanelHeader } from "./PanelHeader";

export type Change = Record<string, unknown>;

const LIST_MODES = [{ value: "existing" as const, label: "Existing list" }, { value: "new" as const, label: "Create new list" }];

/** Where the rows go, and what to open when they are in. */
export function ImportIntoCard({ view, check, onChange }: { view: ImportView; check: ImportCheck | null; onChange: (change: Change) => void }) {
  const [name, setName] = useState(view.new_list_name);
  const nameId = useId();
  const afterId = useId();
  // What is typed is kept once the typing pauses.
  useEffect(() => {
    if (name === view.new_list_name) return;
    const timer = setTimeout(() => onChange({ new_list_name: name }), 500);
    return () => clearTimeout(timer);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = view.options.lists.find((candidate) => candidate.id === view.list_id);
  const after = afterChoice(view.after);
  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <PanelHeader title="Import into" actions={<Link href="/lists" className="rounded-sm text-11 font-semibold text-brand-strong hover:underline">Manage lists</Link>} />
      <Segmented label="Import into" className="w-full [&>*]:flex-1" value={view.list_mode} onChange={(mode) => onChange({ list_mode: mode })} options={LIST_MODES} />
      {view.list_mode === "existing" ? (
        <OptionPicker
          label="List to import into" width={328} value={view.list_id ?? undefined} onChange={(id) => onChange({ list_id: id })} empty="No list matches."
          options={view.options.lists.map((option) => ({ value: option.id, label: option.name, aside: formatCount(option.contacts) }))}
          trigger={(
            <button type="button" className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-12 font-medium text-ink outline-none hover:bg-subtle focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand-tint">
              <ListChecks size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
              <span className={cn("min-w-0 flex-1 truncate", !list && "text-ink-3")}>{list?.name ?? (view.options.lists.length ? "Choose a list" : "There is no list yet")}</span>
              <ChevronDown size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
            </button>
          )}
        />
      ) : (
        <>
          <label htmlFor={nameId} className="sr-only">Name of the new list</label>
          <Input id={nameId} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name !== view.new_list_name) onChange({ new_list_name: name }); }} placeholder="Name of the new list" frameClassName="h-9" />
        </>
      )}
      <p className="text-11 text-ink-2">{listLine(view, check)}</p>
      <div className="flex flex-col gap-2 border-t border-line pt-2.5">
        <label htmlFor={afterId} className="flex cursor-pointer items-start gap-2 text-12 text-ink">
          <Checkbox id={afterId} className="mt-px" checked={after !== AFTER_NONE} onChange={(on) => onChange({ after: afterFrom(on ? AFTER_NEW : AFTER_NONE) })} />
          <span>Set up a campaign with this list after import</span>
        </label>
        {after !== AFTER_NONE ? (
          <Select label="Campaign to set up" className="w-full" value={after} onChange={(choice) => onChange({ after: afterFrom(choice) })} options={afterOptions(view)} />
        ) : null}
      </div>
    </Card>
  );
}

/** Which details make a row a contact Linki already has, and what happens to one that is. */
export function DuplicateCard({ view, check, checking, onChange }: { view: ImportView; check: ImportCheck | null; checking: boolean; onChange: (change: Change) => void }) {
  const by = check?.summary.duplicates.by;
  const emailId = useId();
  const nameId = useId();
  const note = check ? duplicateNote(check.summary, view.on_duplicate) : null;
  const linkedin = matchCount(by?.linkedin, true);
  const email = matchCount(by?.email, view.match.email);
  const name = matchCount(by?.name_company, view.match.name_company);
  const count = (found: { text: string; tone: "warn" | "muted" }) => <span className={cn("shrink-0 text-11 font-medium", found.tone === "warn" ? "text-warn" : "text-ink-3")}>{checking && found.tone === "muted" && found.text === "—" ? <Spinner size={11} label="Checking" /> : found.text}</span>;
  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <PanelHeader title="Duplicate matching" subtitle="Match incoming rows against your workspace" />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-12 text-ink">
          <Tooltip label="Always matched on: two contacts cannot have the same LinkedIn profile.">
            <span className="inline-flex"><Checkbox checked disabled onChange={() => undefined} label="LinkedIn profile, always matched on" /></span>
          </Tooltip>
          <span className="min-w-0 flex-1">LinkedIn profile</span>
          {count(linkedin)}
        </div>
        <div className="flex items-center gap-2 text-12 text-ink">
          <Checkbox id={emailId} checked={view.match.email} onChange={(on) => onChange({ match: { email: on } })} />
          <label htmlFor={emailId} className="min-w-0 flex-1 cursor-pointer">Email address</label>
          {count(email)}
        </div>
        <div className="flex items-center gap-2 text-12 text-ink">
          <Checkbox id={nameId} checked={view.match.name_company} onChange={(on) => onChange({ match: { name_company: on } })} />
          <label htmlFor={nameId} className="min-w-0 flex-1 cursor-pointer">Full name + company</label>
          {count(name)}
        </div>
      </div>
      <Eyebrow className="pt-1">When a duplicate is found</Eyebrow>
      <Segmented label="When a duplicate is found" className="w-full [&>*]:flex-1" value={view.on_duplicate} onChange={(choice) => onChange({ on_duplicate: choice })} options={ON_DUPLICATE_OPTIONS} />
      <p className="text-11 leading-4 text-ink-2">{ON_DUPLICATE_HINT[view.on_duplicate]}</p>
      {note ? (
        <p className="flex gap-2 rounded-lg bg-warn-tint p-2.5 text-11 leading-4 text-ink">
          <Copy size={13} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          {note}
        </p>
      ) : null}
    </Card>
  );
}

const LEVEL_ICON = { error: CircleAlert, warning: TriangleAlert, good: CircleCheck } as const;
const LEVEL_TEXT = { error: "text-bad", warning: "text-warn", good: "text-good" } as const;
const FIGURE_TEXT = { good: "text-good", warn: "text-warn", bad: "text-bad", muted: "text-ink-3" } as const;

/** The dry run: how many rows are ready, and what is wrong or worth knowing about the rest. */
export function ValidationCard({ view, check, checking, error, onRerun }: { view: ImportView; check: ImportCheck | null; checking: boolean; error: string | null; onRerun: () => void }) {
  const [open, setOpen] = useState<Issue | null>(null);
  return (
    <Card className="flex flex-col">
      <PanelHeader
        className="px-3.5 py-3" title="Validation"
        subtitle={checking ? "Checking the rows" : check ? `Checked ${formatCount(check.summary.rows)} rows · ${formatRelative(check.checked_at)}` : error ? "Could not be checked" : "Not checked yet"}
        actions={<Button size="sm" icon={RefreshCw} loading={checking} onClick={onRerun}>Re-run</Button>}
      />
      {error && !check ? <div className="border-t border-line p-3.5"><Alert tone="bad" title={error} /></div> : null}
      {check ? (
        <>
          <dl className="grid grid-cols-3 border-y border-line">
            {validationFigures(check.summary).map((figure) => (
              <div key={figure.key} className="flex flex-col gap-0.5 px-3.5 py-3">
                <dd className={cn("text-18 font-semibold tracking-[-0.3px]", FIGURE_TEXT[figure.tone])}>{figure.value}</dd>
                <dt className="text-105 text-ink-3">{figure.label}</dt>
              </div>
            ))}
          </dl>
          {check.problem ? <div className="border-b border-line p-3.5"><Alert tone="warn" title={check.problem} /></div> : null}
          {check.issues.length === 0 ? (
            <p className="flex items-center gap-2 px-3.5 py-3 text-12 text-ink-2"><CircleCheck size={14} className="shrink-0 text-good" aria-hidden="true" />Nothing to fix in this file.</p>
          ) : (
            <ul className="flex flex-col">
              {check.issues.map((issue) => {
                const text = issueText(issue);
                const Glyph = LEVEL_ICON[issue.level];
                return (
                  <li key={issue.key} className="flex items-start gap-2.5 border-b border-line px-3.5 py-2.5 last:border-b-0">
                    <Glyph size={14} className={cn("mt-0.5 shrink-0", LEVEL_TEXT[issue.level])} aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-12 font-semibold text-ink">{text.title}</span>
                      {text.detail ? <span className="text-11 leading-4 text-ink-2">{text.detail}</span> : null}
                    </div>
                    {issue.rows.length > 0 ? <TextAction aria-label={`View: ${text.title}`} onClick={() => setOpen(issue)}>View</TextAction> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : !error ? <div className="flex items-center gap-2 border-t border-line px-3.5 py-4 text-12 text-ink-2"><Spinner size={13} label="Checking" />Going through {formatCount(view.file.rows)} rows</div> : null}
      <IssueDrawer issue={open} hasHeader={view.file.has_header} onClose={() => setOpen(null)} />
    </Card>
  );
}

function IssueDrawer({ issue, hasHeader, onClose }: { issue: Issue | null; hasHeader: boolean; onClose: () => void }) {
  const text = issue ? issueText(issue) : null;
  return (
    <Drawer open={issue !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={text?.title ?? ""} description={text?.detail || undefined} width={460}>
      {issue ? (
        <div className="flex flex-col gap-2.5">
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-line bg-subtle px-3 py-2 text-10 font-semibold uppercase tracking-label text-ink-3"><span>Row</span><span>What it has</span></div>
            <ul className="flex flex-col">
              {issue.rows.map((row) => (
                <li key={row.row} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
                  <span className="font-mono text-115 text-ink-2">{formatCount(row.row)}</span>
                  <span className={cn("truncate text-115", row.value ? "font-mono text-ink" : "text-ink-3")} title={row.value ?? undefined}>{row.value ?? "(empty)"}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-11 text-ink-3">
            {issue.count > issue.rows.length ? `The first ${formatCount(issue.rows.length)} of ${formatCount(issue.count)}. ` : ""}Row numbers are the lines of the file{hasHeader ? ", counting its header as row 1" : ""}. Fix them in the file and use Replace file, or import as it is.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

export function TemplateCard() {
  return (
    <Card className="flex items-center gap-2.5 p-3">
      <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md bg-subtle text-ink-2"><Download size={14} aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-col gap-px">
        <a href={TEMPLATE_PATH} className="truncate rounded-sm text-12 font-semibold text-brand-strong hover:underline">Download the Linki CSV template</a>
        <span className="truncate text-105 text-ink-3">The columns Linki recognises, with an example row</span>
      </div>
    </Card>
  );
}
