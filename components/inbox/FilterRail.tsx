import type { ReactNode } from "react";
import { Bookmark } from "lucide-react";
import { Avatar, Skeleton, TextAction } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { STATUSES, TEMPERATURES, VERDICTS, split, toggled, type ConversationFacets, type FilterKey, type InboxFilters, type InboxMeta, type SavedView } from "./model";

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex w-full flex-col gap-0.5" aria-label={label}>
      <div className="flex h-5 items-center justify-between px-2">
        <h3 className="text-10 font-semibold uppercase tracking-label text-ink-3">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One line of the rail: a filter that is on or off, with how many conversations it would show. */
function Row({ active, onClick, lead, label, count }: { active: boolean; onClick: () => void; lead: ReactNode; label: string; count?: number }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className={cn("flex h-[26px] w-full items-center justify-between gap-2 rounded-md px-2 text-left transition-colors", active ? "bg-brand-tint" : "hover:bg-subtle")}
    >
      <span className="flex min-w-0 items-center gap-[7px]">
        {lead}
        <span className={cn("truncate text-115", active ? "font-semibold text-brand-strong" : "font-medium text-ink-2")}>{label}</span>
      </span>
      {count !== undefined ? <span className={cn("shrink-0 text-105 font-semibold tabular-nums", active ? "text-brand-strong" : "text-ink-3")}>{formatCount(count)}</span> : null}
    </button>
  );
}

const Dot = ({ className }: { className: string }) => <span className={cn("size-1.5 shrink-0 rounded-full", className)} aria-hidden="true" />;

/**
 * The filters down the left of the inbox. Every row is a switch; several in one group
 * widen the list, and each count is what that row would show with the other groups as
 * they are.
 */
export function FilterRail({
  filters, facets, meta, views, activeViewId, onChange, onReset, onView, onManageTags,
}: {
  filters: InboxFilters;
  facets: ConversationFacets | undefined;
  meta: InboxMeta | undefined;
  views: SavedView[];
  activeViewId: string | null;
  onChange: (key: FilterKey, value: string) => void;
  onReset: () => void;
  onView: (view: SavedView) => void;
  onManageTags: () => void;
}) {
  const flip = (key: FilterKey, item: string) => onChange(key, toggled(filters[key], item));
  const on = (key: FilterKey, item: string) => split(filters[key]).includes(item);
  const anyActive = (Object.keys(filters) as FilterKey[]).some((key) => key !== "view" && filters[key] !== "");
  // Members with something assigned, most first; the rest are reachable from a conversation's own assign control.
  const members = (meta?.members ?? []).filter((member) => (facets?.assignee[member.id] ?? 0) > 0 || on("assignee", member.id))
    .sort((a, b) => (facets?.assignee[b.id] ?? 0) - (facets?.assignee[a.id] ?? 0));

  return (
    <aside className="flex h-full w-[180px] shrink-0 flex-col gap-[13px] overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-card" aria-label="Filters">
      <div className="flex w-full items-center justify-between">
        <h2 className="text-13 font-semibold tracking-[-0.1px] text-ink">Filters</h2>
        <TextAction onClick={onReset} className={cn(!anyActive && "invisible")}>Reset</TextAction>
      </div>

      {!facets ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading filters">
          {Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="h-[22px] w-full" />)}
        </div>
      ) : (
        <>
          <Section label="Verdict">
            {VERDICTS.map((verdict) => (
              <Row key={verdict.key} active={on("verdict", verdict.key)} onClick={() => flip("verdict", verdict.key)} lead={<Dot className={verdict.dot} />} label={verdict.label} count={facets.verdict[verdict.key] ?? 0} />
            ))}
          </Section>
          <Section label="Status">
            {STATUSES.map((status) => (
              <Row key={status.key} active={on("status", status.key)} onClick={() => flip("status", status.key)} lead={<Dot className={status.dot} />} label={status.label} count={facets.status[status.key] ?? 0} />
            ))}
          </Section>
          <Section label="Sentiment">
            {TEMPERATURES.map((temperature) => (
              <Row key={temperature.key} active={on("temperature", temperature.key)} onClick={() => flip("temperature", temperature.key)} lead={<Dot className={temperature.dot} />} label={temperature.label} count={facets.temperature[temperature.key] ?? 0} />
            ))}
          </Section>
          <Section label="Assignee">
            <Row
              active={on("assignee", "none")} onClick={() => flip("assignee", "none")} label="Unassigned" count={facets.assignee.none ?? 0}
              lead={<span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-control text-85 font-semibold text-ink-2" aria-hidden="true">—</span>}
            />
            {members.map((member) => (
              <Row key={member.id} active={on("assignee", member.id)} onClick={() => flip("assignee", member.id)} lead={<Avatar name={member.name} size={18} tint="bg-brand-tint" className="text-brand-strong" />} label={member.name} count={facets.assignee[member.id] ?? 0} />
            ))}
          </Section>
          <Section label="SLA">
            <Row active={filters.sla === "overdue"} onClick={() => onChange("sla", filters.sla === "overdue" ? "" : "overdue")} lead={<Dot className="bg-bad" />} label="Overdue" count={facets.overdue} />
            <Row active={filters.sla === "today"} onClick={() => onChange("sla", filters.sla === "today" ? "" : "today")} lead={<Dot className="bg-warn" />} label="Due today" count={facets.due_today} />
          </Section>
          {meta && meta.tags.length > 0 ? (
            <Section label="Tags" action={<TextAction onClick={onManageTags} className="text-10">Manage</TextAction>}>
              {meta.tags.map((tag) => (
                <Row key={tag.id} active={filters.tag === tag.id} onClick={() => onChange("tag", filters.tag === tag.id ? "" : tag.id)} lead={<span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />} label={tag.name} count={tag.conversations} />
              ))}
            </Section>
          ) : null}
          {views.length > 0 ? (
            <Section label="Saved views">
              {views.map((view) => (
                <Row key={view.id} active={view.id === activeViewId} onClick={() => onView(view)} lead={<Bookmark size={13} className={cn("shrink-0", view.id === activeViewId ? "text-brand-strong" : "text-ink-3")} aria-hidden="true" />} label={view.name} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </aside>
  );
}
