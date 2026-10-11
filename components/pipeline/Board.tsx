import { useState, type DragEvent } from "react";
import { Calendar, CircleCheck, Ellipsis, KanbanSquare, Pencil, Plus, RefreshCw, Reply, SendHorizontal, SlidersHorizontal, Trash2 } from "lucide-react";
import { Avatar, Button, Card, CardHeader, EmptyState, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Pill, Skeleton, TONE_SOLID, Tooltip } from "@/components/ui";
import { MenuChoice } from "@/components/inbox/MenuChoice";
import { cn } from "@/lib/client/cn";
import { formatCount, formatMoney, plural } from "@/lib/client/format";
import { dealDate, dealSubline, sourceLabel, type Column, type Opportunity } from "./model";

export interface BoardProps {
  columns: Column[] | undefined;
  currency: string;
  /** A member can move, add and edit deals; a viewer reads. */
  canEdit: boolean;
  /** A manager can change the stages. */
  canManage: boolean;
  /** "HubSpot synced 6 min ago", when a CRM is connected. */
  syncNote: { label: string; failed: boolean } | null;
  onAdd: (stageId: string | null) => void;
  onOpen: (deal: Opportunity) => void;
  onMove: (deal: Opportunity, stageId: string) => void;
  onDelete: (deal: Opportunity) => void;
  onEditStages: () => void;
}

/** The opportunities, a column to a stage. A deal moves by being dragged, or from its menu. */
export function Board({ columns, currency, canEdit, canManage, syncNote, onAdd, onOpen, onMove, onDelete, onEditStages }: BoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const deals = columns?.flatMap((column) => column.deals) ?? [];
  const stages = columns?.filter((column) => column.stage) ?? [];

  function drop(event: DragEvent, column: Column) {
    event.preventDefault();
    const deal = deals.find((item) => item.id === (event.dataTransfer.getData("text/plain") || dragging));
    setDragging(null);
    setOver(null);
    if (deal && column.stage && deal.stage_id !== column.stage.id) onMove(deal, column.stage.id);
  }

  return (
    <Card className="flex shrink-0 flex-col gap-3 p-3.5">
      <CardHeader
        title="Opportunities by stage"
        subtitle={canEdit ? "Drag a card to move a deal · weighted value uses stage probability" : "Weighted value uses stage probability"}
        actions={
          <>
            {syncNote ? <Pill tone={syncNote.failed ? "bad" : "neutral"} icon={RefreshCw}>{syncNote.label}</Pill> : null}
            {canManage ? <Button icon={SlidersHorizontal} onClick={onEditStages}>Edit stages</Button> : null}
          </>
        }
      />
      {!columns ? (
        <div className="grid grid-flow-col auto-cols-[minmax(224px,1fr)] gap-2.5 overflow-hidden" aria-busy="true" aria-label="Loading the board">
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[220px] rounded-lg" />)}
        </div>
      ) : stages.length === 0 ? (
        <EmptyState icon={KanbanSquare} title="This pipeline has no stages" action={canManage ? <Button variant="primary" icon={Plus} onClick={onEditStages}>Add stages</Button> : undefined}>
          {canManage ? "Add the stages a deal passes through, and the board will have a column for each." : "A manager has to add the stages a deal passes through."}
        </EmptyState>
      ) : (
        <div className="grid grid-flow-col auto-cols-[minmax(224px,1fr)] gap-2.5 overflow-x-auto pb-1">
          {columns.map((column) => (
            <section
              key={column.id}
              aria-label={`${column.name}: ${formatCount(column.deals.length)} ${plural(column.deals.length, "opportunity", "opportunities")}`}
              data-stage={column.id}
              onDragOver={column.stage && dragging ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (over !== column.id) setOver(column.id); } : undefined}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === column.id ? null : current)); }}
              onDrop={column.stage ? (event) => drop(event, column) : undefined}
              className={cn("flex min-w-0 flex-col gap-2 rounded-lg bg-subtle p-2 transition-shadow", over === column.id && "ring-2 ring-brand")}
            >
              <header className="flex flex-col gap-1 px-1 pt-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("size-[7px] shrink-0 rounded-full", TONE_SOLID[column.tone])} aria-hidden="true" />
                    <h3 className="truncate text-125 font-semibold text-ink">{column.name}</h3>
                  </span>
                  <span className="shrink-0 text-11 font-semibold text-ink-3">{formatCount(column.deals.length)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 font-mono text-105 text-ink-2">
                  <span>{formatMoney(column.value, currency)}</span>
                  {column.probability === null ? null : <span className="text-ink-3">{column.probability}%</span>}
                </div>
              </header>
              <ul className="flex flex-col gap-2">
                {column.deals.map((deal) => {
                  const date = dealDate(deal, column.stage);
                  return (
                    <li key={deal.id}>
                      <article
                        draggable={canEdit}
                        data-deal={deal.id}
                        onDragStart={canEdit ? (event) => { event.dataTransfer.setData("text/plain", deal.id); event.dataTransfer.effectAllowed = "move"; setDragging(deal.id); } : undefined}
                        onDragEnd={() => { setDragging(null); setOver(null); }}
                        className={cn("group flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5 shadow-card", canEdit && "cursor-grab active:cursor-grabbing", dragging === deal.id && "opacity-50")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          {canEdit ? (
                            <button type="button" onClick={() => onOpen(deal)} className="min-w-0 truncate rounded-sm text-left text-125 font-semibold text-ink hover:underline">{deal.name}</button>
                          ) : (
                            <span className="min-w-0 truncate text-125 font-semibold text-ink">{deal.name}</span>
                          )}
                          <span className="shrink-0 font-mono text-115 text-ink">{deal.amount === null ? "—" : formatMoney(deal.amount, deal.currency)}</span>
                        </div>
                        <p className="truncate text-11 text-ink-3">{dealSubline(deal)}</p>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Tooltip label={deal.owner_name || deal.owner_email ? `Owner: ${deal.owner_name?.trim() || deal.owner_email}` : "No owner"}>
                              <span className="inline-flex" tabIndex={-1}><Avatar name={deal.owner_name?.trim() || deal.owner_email?.split("@")[0] || null} size={18} /></span>
                            </Tooltip>
                            {deal.source === "reply" || deal.source === "campaign" ? (
                              <Tooltip label={sourceLabel(deal.source)}>
                                <span className="inline-flex text-ink-3">{deal.source === "reply" ? <Reply size={12} aria-label={sourceLabel(deal.source)} /> : <SendHorizontal size={12} aria-label={sourceLabel(deal.source)} />}</span>
                              </Tooltip>
                            ) : null}
                            {deal.open_task_count > 0 ? (
                              <span className="flex items-center gap-0.5 text-105 text-ink-3" title={`${deal.open_task_count} open ${plural(deal.open_task_count, "task", "tasks")}`}>
                                <CircleCheck size={11} aria-hidden="true" />{deal.open_task_count}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {date ? <span className={cn("flex items-center gap-1 text-11", date.late ? "text-bad" : "text-ink-3")} title={date.late ? "Expected to close before today" : "Expected to close"}><Calendar size={11} aria-hidden="true" />{date.label}</span> : null}
                            {canEdit ? (
                              <Menu trigger={<IconButton icon={Ellipsis} label={`Move or change ${deal.name}`} size={22} className="-mr-1" />}>
                                <MenuItem icon={Pencil} onSelect={() => onOpen(deal)}>Edit</MenuItem>
                                <MenuSeparator />
                                <MenuLabel>Move to</MenuLabel>
                                {stages.map((stage) => (
                                  <MenuChoice key={stage.id} checked={deal.stage_id === stage.id} onSelect={() => { if (deal.stage_id !== stage.id) onMove(deal, stage.id); }}>{stage.name}</MenuChoice>
                                ))}
                                <MenuSeparator />
                                <MenuItem icon={Trash2} tone="danger" onSelect={() => onDelete(deal)}>Delete</MenuItem>
                              </Menu>
                            ) : null}
                          </span>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ul>
              {column.deals.length === 0 && !canEdit ? <p className="px-1 pb-1 text-11 text-ink-3">Nothing here.</p> : null}
              {canEdit && column.stage ? (
                <button type="button" onClick={() => onAdd(column.stage!.id)} className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line-strong bg-subtle text-115 font-medium text-ink-2 hover:bg-surface hover:text-ink">
                  <Plus size={12} aria-hidden="true" />Add deal
                </button>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
