import { useEffect, useState, type ReactNode } from "react";
import { AlarmClock, CircleCheck, Clock, ListTodo, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Avatar, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, Pagination, Pill, SearchInput, Segmented, Select, Skeleton, TextAction, Textarea, Tooltip, confirm,
} from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, plural } from "@/lib/client/format";
import { useDebounced, useTableState } from "@/lib/client/table-state";
import { createTask, deleteTask, updateTask, type TaskBody } from "./api";
import { RecordSearch, type Picked } from "./RecordSearch";
import {
  PRIORITY_LABEL, PRIORITY_TONE, TASKS_PATH, TASK_SCOPES, dueFields, dueFromFields, dueLabel, memberName, taskCountsLine, taskSubline, todayQuery,
  type Member, type Opportunity, type Priority, type TaskItem, type TaskScope, type TasksData,
} from "./model";

export type TaskDraft = { mode: "new" } | { mode: "edit"; task: TaskItem };

interface ListProps {
  /** The owner filter at the top of the page, as an assignee: a member id, `none`, or `all`. */
  owner: string;
  canEdit: boolean;
  /** Read everything on the page again: a task finished here changes the counts, the board's cards and the activity list. */
  onChanged: () => void;
  onEdit: (draft: TaskDraft) => void;
}

/** Tick a task done, or open it again. */
function useToggle(onChanged: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  async function toggle(task: TaskItem, done: boolean) {
    setPending(task.id);
    try {
      await updateTask(task.id, { status: done ? "done" : "open" });
      onChanged();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setPending(null); }
  }
  return { pending, toggle };
}

function TaskRow({ task, canEdit, pending, onToggle, onEdit }: { task: TaskItem; canEdit: boolean; pending: boolean; onToggle: (done: boolean) => void; onEdit: () => void }) {
  const done = task.status === "done";
  const due = dueLabel(task);
  const subline = taskSubline(task);
  return (
    <li className={cn("flex items-center gap-3 px-3.5 py-2.5", task.overdue && "bg-bad-tint/60")}>
      <Checkbox checked={done} disabled={!canEdit || pending} onChange={onToggle} label={done ? `Open "${task.title}" again` : `Mark "${task.title}" done`} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {canEdit ? (
            <button type="button" onClick={onEdit} className={cn("min-w-0 truncate rounded-sm text-left text-125 font-medium hover:underline", done ? "text-ink-3" : "text-ink")}>{task.title}</button>
          ) : (
            <span className={cn("min-w-0 truncate text-125 font-medium", done ? "text-ink-3" : "text-ink")}>{task.title}</span>
          )}
          {task.automatic ? <Tooltip label="Linki made this task by itself"><span className="inline-flex"><Pill tone="brand" size="sm" icon={Sparkles}>Auto</Pill></span></Tooltip> : null}
        </div>
        {subline ? <p className="truncate text-11 text-ink-3">{subline}</p> : null}
      </div>
      <span className={cn("flex w-[132px] shrink-0 items-center gap-1.5 text-115", task.overdue ? "font-medium text-bad" : done ? "text-ink-3" : "text-ink-2")}>
        {due ? <>{task.overdue ? <AlarmClock size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}{due}</> : <span className="text-ink-3">No date</span>}
      </span>
      <span className="flex w-[68px] shrink-0 justify-start"><Pill tone={done ? "neutral" : PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Pill></span>
      <Tooltip label={task.assignee ? `Assigned to ${task.assignee.name}` : "Nobody has this"}>
        <span className="inline-flex shrink-0" tabIndex={-1}>
          {task.assignee ? <Avatar name={task.assignee.name} size={24} /> : <span className="inline-flex size-6 rounded-full border border-dashed border-line-strong" aria-label="Unassigned" />}
        </span>
      </Tooltip>
    </li>
  );
}

function Rows({ data, error, canEdit, pending, toggle, onEdit, onRetry, empty }: {
  data: TasksData | undefined; error: unknown; canEdit: boolean; pending: string | null; toggle: (task: TaskItem, done: boolean) => void; onEdit: (draft: TaskDraft) => void; onRetry: () => void; empty: ReactNode;
}) {
  if (error && !data) return <ErrorState message={errorMessage(error)} onRetry={onRetry} />;
  if (!data) {
    return (
      <ul className="divide-y divide-line" aria-busy="true" aria-label="Loading tasks">
        {Array.from({ length: 4 }, (_, index) => <li key={index} className="flex items-center gap-3 px-3.5 py-3"><Skeleton className="size-4" /><Skeleton className="h-3 flex-1" /><Skeleton className="h-3 w-20" /></li>)}
      </ul>
    );
  }
  if (data.tasks.length === 0) return <>{empty}</>;
  return (
    <ul className="divide-y divide-line">
      {data.tasks.map((task) => <TaskRow key={task.id} task={task} canEdit={canEdit} pending={pending === task.id} onToggle={(done) => void toggle(task, done)} onEdit={() => onEdit({ mode: "edit", task })} />)}
    </ul>
  );
}

const assigneeOf = (owner: string, scope: TaskScope) => (scope === "mine" ? "me" : owner === "all" ? undefined : owner);

/** The tasks on the board view: what is open and what was finished today, a handful at a time. */
export function TasksCard({ owner, canEdit, onChanged, onEdit, onViewAll }: ListProps & { onViewAll: () => void }) {
  const [scope, setScope] = useState<TaskScope>("all");
  const [today] = useState(() => todayQuery());
  const list = useApi<TasksData>(TASKS_PATH, { status: "today", limit: 6, ...today, assignee: assigneeOf(owner, scope), overdue: scope === "overdue" ? "1" : undefined });
  const { pending, toggle } = useToggle(onChanged);
  const counts = list.data?.counts;
  return (
    <Card className="flex min-w-0 flex-1 flex-col self-start">
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Tasks</h2>
          {counts && counts.overdue > 0 ? <Pill tone="bad">{formatCount(counts.overdue)} overdue</Pill> : null}
          {counts ? <span className="truncate text-11 text-ink-3">{taskCountsLine(counts)}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Segmented label="Which tasks" size="sm" value={scope} onChange={setScope} options={[...TASK_SCOPES]} />
          {canEdit ? <Button icon={Plus} onClick={() => onEdit({ mode: "new" })}>New task</Button> : null}
        </div>
      </div>
      <div className="border-t border-line">
        <Rows
          data={list.data} error={list.error} canEdit={canEdit} pending={pending} toggle={toggle} onEdit={onEdit} onRetry={() => void list.mutate()}
          empty={
            <EmptyState icon={CircleCheck} title={scope === "overdue" ? "Nothing is overdue" : scope === "mine" ? "Nothing is waiting on you" : "No open tasks"}>
              {scope === "all" ? "A positive reply makes one by itself. You can also add one for a contact, a company or a deal." : undefined}
            </EmptyState>
          }
        />
      </div>
      {list.data && list.data.total > list.data.tasks.length ? (
        <div className="flex items-center justify-between border-t border-line px-3.5 py-2">
          <span className="text-11 text-ink-3">Showing {list.data.tasks.length} of {formatCount(list.data.total)}</span>
          <TextAction onClick={onViewAll}>View all tasks</TextAction>
        </div>
      ) : null}
    </Card>
  );
}

const STATUS_OPTIONS = [{ value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "all", label: "All" }] as const;
const PRIORITY_OPTIONS = [{ value: "any", label: "Any priority" }, { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }];
const DUE_OPTIONS = [{ value: "any", label: "Any date" }, { value: "overdue", label: "Overdue" }];

/** Every task, with filters, a search, and pages. */
export function TasksView({ owner, canEdit, onChanged, onEdit }: ListProps) {
  const table = useTableState({ pageSize: 25, sort: { key: "due", direction: "asc" }, filters: { status: "open", priority: "any", due: "any" } });
  const [search, setSearch] = useState<string | null>(null);
  const typed = search ?? table.search;
  const settled = useDebounced(typed);
  const [today] = useState(() => todayQuery());
  // The search box writes to the address bar once typing has stopped.
  useEffect(() => {
    if (table.ready && search !== null && settled === search && settled !== table.search) table.set({ search: settled });
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useApi<TasksData>(table.ready ? TASKS_PATH : null, {
    status: table.filters.status, priority: table.filters.priority === "any" ? undefined : table.filters.priority, overdue: table.filters.due === "overdue" ? "1" : undefined,
    assignee: owner === "all" ? undefined : owner, q: table.search || undefined, page: table.page, limit: table.pageSize, ...today,
  });
  const { pending, toggle } = useToggle(onChanged);
  const counts = list.data?.counts;
  const filtered = table.activeFilterCount > 0 || Boolean(table.search) || owner !== "all";
  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Tasks</h2>
          {counts && counts.overdue > 0 ? <Pill tone="bad">{formatCount(counts.overdue)} overdue</Pill> : null}
          {counts ? <span className="truncate text-11 text-ink-3">{taskCountsLine(counts)}</span> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SearchInput value={typed} onChange={setSearch} placeholder="Search tasks" frameClassName="w-[200px]" />
          <Segmented label="Status" size="sm" value={table.filters.status as "open" | "done" | "all"} onChange={(status) => table.set({ filters: { status } })} options={[...STATUS_OPTIONS]} />
          <Select label="Priority" size="sm" value={table.filters.priority} onChange={(priority) => table.set({ filters: { priority } })} options={PRIORITY_OPTIONS} />
          <Select label="Due" size="sm" value={table.filters.due} onChange={(due) => table.set({ filters: { due } })} options={DUE_OPTIONS} />
          {canEdit ? <Button variant="primary" icon={Plus} onClick={() => onEdit({ mode: "new" })}>New task</Button> : null}
        </div>
      </div>
      <div className="border-t border-line">
        <Rows
          data={list.data} error={list.error} canEdit={canEdit} pending={pending} toggle={toggle} onEdit={onEdit} onRetry={() => void list.mutate()}
          empty={
            <EmptyState icon={ListTodo} title={filtered ? "No task matches" : table.filters.status === "done" ? "Nothing has been finished yet" : "No open tasks"}>
              {filtered ? "Try a different filter or search." : "A positive reply makes one by itself. You can also add one for a contact, a company or a deal."}
            </EmptyState>
          }
        />
      </div>
      {list.data && list.data.total > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2">
          <span className="text-11 text-ink-3">{formatCount(list.data.total)} {plural(list.data.total, "task", "tasks")}</span>
          <Pagination page={table.page} pageSize={table.pageSize} total={list.data.total} onPageChange={(page) => table.set({ page })} />
        </div>
      ) : null}
    </Card>
  );
}

const NOBODY = "none";
const PRIORITIES: Array<{ value: Priority; label: string }> = [{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }];

/** Add a task, or change one: what to do, by when, how much it matters, who does it, and what it is about. */
export function TaskDialog({ draft, members, opportunities, me, onClose, onSaved }: { draft: TaskDraft; members: Member[]; opportunities: Opportunity[]; me: string | null; onClose: () => void; onSaved: () => void }) {
  const existing = draft.mode === "edit" ? draft.task : null;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [notes, setNotes] = useState(existing?.description ?? "");
  const [due, setDue] = useState(() => dueFields(existing));
  const [priority, setPriority] = useState<Priority>(existing?.priority ?? "medium");
  const [assignee, setAssignee] = useState(existing ? existing.assignee?.id ?? NOBODY : me && members.some((member) => member.id === me) ? me : NOBODY);
  const [contact, setContact] = useState<Picked | null>(existing?.contact ? { id: existing.contact.id, label: existing.contact.name } : null);
  const [company, setCompany] = useState<Picked | null>(existing?.company?.id ? { id: existing.company.id, label: existing.company.name } : null);
  const [opportunity, setOpportunity] = useState(existing?.opportunity?.id ?? NOBODY);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  // The opportunity it is already about stays a choice, even when the owner filter has it off the board.
  const deals = [...opportunities.map((deal) => ({ value: deal.id, label: deal.name })), ...(existing?.opportunity && !opportunities.some((deal) => deal.id === existing.opportunity!.id) ? [{ value: existing.opportunity.id, label: existing.opportunity.name }] : [])];
  // Someone who has left the workspace may still have the task; keep them shown until it is given to someone else.
  const people = [...members.map((member) => ({ value: member.id, label: memberName(member) })), ...(existing?.assignee && !members.some((member) => member.id === existing.assignee!.id) ? [{ value: existing.assignee.id, label: existing.assignee.name, disabled: true }] : [])];

  async function save() {
    if (!title.trim()) return setMissing(true);
    setMissing(false);
    const body: TaskBody = {
      title: title.trim(), description: notes.trim() || null, ...dueFromFields(due.day, due.time), priority,
      assigned_to: assignee === NOBODY ? null : assignee, target_id: contact?.id ?? null, opportunity_id: opportunity === NOBODY ? null : opportunity,
      // The company shown on a task about a contact or a deal is theirs; only a company chosen here is stored.
      company_id: company && company.id !== existing?.company?.id ? company.id : company ? undefined : null,
    };
    setBusy(true);
    try {
      if (existing) await updateTask(existing.id, body);
      else await createTask(body);
      toast.success(existing ? "Task saved" : "Task added");
      onSaved();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function remove() {
    if (!existing) return;
    if (!(await confirm({ title: "Delete this task?", body: existing.title, confirmLabel: "Delete", tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteTask(existing.id);
      toast.success("Task deleted");
      onSaved();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title={existing ? "Edit task" : "New task"} icon={ListTodo}
      description={existing?.automatic ? "Linki made this task by itself." : undefined}
      footer={
        <>
          {existing ? <Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => void remove()}>Delete</Button> : <span />}
          <span className="flex items-center gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>{existing ? "Save" : "Add task"}</Button>
          </span>
        </>
      }
    >
      <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="What needs doing" error={missing ? "Say what needs doing." : undefined}>
          {(id) => <Input id={id} data-autofocus value={title} onChange={(event) => { setTitle(event.target.value); setMissing(false); }} placeholder="Send the pricing one-pager" invalid={missing} maxLength={300} />}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Anything that helps whoever does it" maxLength={4000} />}
        </Field>
        <div className="grid grid-cols-[1fr_112px_1fr] gap-3">
          <Field label="Due">{(id) => <Input id={id} type="date" value={due.day} onChange={(event) => setDue({ day: event.target.value, time: event.target.value ? due.time : "" })} />}</Field>
          <Field label="Time">{(id) => <Input id={id} type="time" value={due.time} disabled={!due.day} onChange={(event) => setDue({ ...due, time: event.target.value })} />}</Field>
          <Field label="Assigned to">{(id) => <Select id={id} className="w-full" value={assignee} onChange={setAssignee} options={[...people, { value: NOBODY, label: "Nobody" }]} />}</Field>
        </div>
        <Field label="Priority">{() => <div><Segmented label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} /></div>}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact">{(id) => <RecordSearch id={id} kind="contact" value={contact} onChange={setContact} />}</Field>
          <Field label="Company">{(id) => <RecordSearch id={id} kind="company" value={company} onChange={setCompany} />}</Field>
        </div>
        <Field label="Opportunity">
          {(id) => <Select id={id} className="w-full" value={opportunity} onChange={setOpportunity} options={[{ value: NOBODY, label: "None" }, ...deals]} />}
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
