import Link from "next/link";
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Copy, Ellipsis, ExternalLink, ListPlus, Tag, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Avatar, IconButton, Menu, MenuItem, MenuSeparator, Pill, TONE_SOLID, TONE_TEXT, Tooltip, type Column } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatDate } from "@/lib/client/format";
import {
  COLUMNS, LINKEDIN_LABEL, campaignTone, emailState, intentTone, lastActivityLabel, listsSummary, tagTone,
  type ColumnKey, type ContactRow, type EmailKind,
} from "./model";

const DASH = <span className="text-ink-3">—</span>;
const EMAIL_ICON: Record<EmailKind, LucideIcon> = { verified: CircleCheck, checked: CircleCheck, catchall: CircleAlert, invalid: CircleX, unverified: CircleHelp, unchecked: CircleDashed };

export type RowAction = "list" | "tag" | "delete";

/** Name and title, with the name a link so the profile can be reached by keyboard. */
function Identity({ row, href, onVisit }: { row: ContactRow; href: string; onVisit: () => void }) {
  const name = row.full_name?.trim() || "No name";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar name={row.full_name} size={26} />
      <div className="flex min-w-0 flex-col gap-px">
        <Link href={href} onClick={(event) => { event.stopPropagation(); onVisit(); }} className="truncate text-12 font-semibold tracking-snug text-ink hover:text-brand-strong">
          {name}
        </Link>
        {row.title ? <span className="truncate text-105 text-ink-3">{row.title}</span> : null}
      </div>
    </div>
  );
}

function Email({ row }: { row: ContactRow }) {
  if (!row.email) return DASH;
  const state = emailState(row.email_status);
  const Glyph = EMAIL_ICON[state.kind];
  return (
    <div className="flex min-w-0 items-center gap-[5px]">
      <Tooltip label={state.title}>
        <span className={cn("inline-flex shrink-0", state.tone === "neutral" ? "text-ink-3" : TONE_TEXT[state.tone], state.kind === "checked" && "opacity-60")}>
          <Glyph size={12} aria-label={state.title} />
        </span>
      </Tooltip>
      <span className={cn("truncate text-11", state.kind === "invalid" ? "text-ink-3 line-through" : "text-ink-2")}>{row.email}</span>
    </div>
  );
}

function Intent({ score }: { score: number }) {
  const tone = intentTone(score);
  return (
    <div className="flex items-center gap-[7px]">
      <span className={cn("w-[18px] text-115 font-semibold tabular-nums", tone === "neutral" ? "text-ink-2" : TONE_TEXT[tone])}>{score}</span>
      <span className="h-1 w-[34px] overflow-hidden rounded-full bg-control" aria-hidden="true">
        <span style={{ width: `${Math.max(4, Math.min(100, score))}%` }} className={cn("block h-full rounded-full", TONE_SOLID[tone])} />
      </span>
    </div>
  );
}

const CELLS: Record<ColumnKey, (row: ContactRow) => React.ReactNode> = {
  company: (row) => (row.company ? <span className="text-115 font-medium text-ink-2">{row.company}</span> : DASH),
  email: (row) => <Email row={row} />,
  linkedin: (row) => {
    const status = LINKEDIN_LABEL[row.linkedin_status];
    return (
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_SOLID[status.tone])} aria-hidden="true" />
        <span className={cn("truncate text-11", row.linkedin_status === "not_connected" ? "text-ink-3" : "text-ink-2")}>{status.label}</span>
      </span>
    );
  },
  list: (row) => {
    const lists = listsSummary(row.lists);
    if (!lists) return DASH;
    const chip = <span className="inline-flex h-[19px] max-w-full items-center truncate rounded-[5px] bg-control px-1.5 text-105 font-medium text-ink-2">{lists.first}</span>;
    return (
      <span className="flex min-w-0 items-center gap-1">
        {chip}
        {lists.more > 0 ? (
          <Tooltip label={row.lists.slice(1).map((list) => list.name).join(", ")}>
            <span className="shrink-0 text-105 font-medium text-ink-3">+{lists.more}</span>
          </Tooltip>
        ) : null}
      </span>
    );
  },
  campaign: (row) =>
    row.campaign ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn("size-[5px] shrink-0 rounded-full", TONE_SOLID[campaignTone(row.campaign.status)])} aria-hidden="true" />
        <span className="truncate text-11 text-ink-2">{row.campaign.name}</span>
        {row.campaign_count > 1 ? <span className="shrink-0 text-105 font-medium text-ink-3">+{row.campaign_count - 1}</span> : null}
      </span>
    ) : DASH,
  intent: (row) => <Intent score={row.intent_score} />,
  owner: (row) =>
    row.owner ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar name={row.owner.name} size={18} />
        <span className="truncate text-11 font-medium text-ink-2">{row.owner.name}</span>
      </span>
    ) : DASH,
  tags: (row) =>
    row.tags.length ? (
      <span className="flex min-w-0 items-center gap-1">
        <Pill size="sm" tone={tagTone(row.tags[0].color)} className="max-w-[104px] truncate">{row.tags[0].name}</Pill>
        {row.tags.length > 1 ? (
          <Tooltip label={row.tags.slice(1).map((tag) => tag.name).join(", ")}>
            <span className="shrink-0 text-105 font-medium text-ink-3">+{row.tags.length - 1}</span>
          </Tooltip>
        ) : null}
      </span>
    ) : DASH,
  last_activity: (row) => <span className="text-11 text-ink-3">{lastActivityLabel(row.last_activity_at)}</span>,
  location: (row) => (row.location ? <span className="text-11 text-ink-2">{row.location}</span> : DASH),
  phone: (row) => (row.phone ? <span className="text-11 tabular-nums text-ink-2">{row.phone}</span> : DASH),
  created: (row) => <span className="text-11 text-ink-3">{formatDate(row.created_at)}</span>,
};

async function copyEmail(email: string) {
  try {
    await navigator.clipboard.writeText(email);
    toast.success("Email address copied");
  } catch {
    toast.error("The address could not be copied. Select it and copy it by hand.");
  }
}

/** The table's columns: the contact, the columns the member has switched on, and the row menu. */
export function contactColumns({
  shown, profileHref, canEdit, onOpen, onAction, onVisit, labels,
}: {
  shown: ColumnKey[];
  profileHref: (row: ContactRow) => string;
  canEdit: boolean;
  onOpen: (row: ContactRow) => void;
  onAction: (action: RowAction, row: ContactRow) => void;
  /** Called when the name link is followed, before the browser leaves. */
  onVisit: () => void;
  /** Other wording for the row menu, where "list" and "delete" mean something narrower (a list's own page). */
  labels?: { list?: string; delete?: string };
}): Column<ContactRow>[] {
  return [
    { key: "contact", header: "Contact", sortKey: "name", cell: (row) => <Identity row={row} href={profileHref(row)} onVisit={onVisit} /> },
    ...COLUMNS.filter((column) => shown.includes(column.key)).map((column): Column<ContactRow> => ({
      key: column.key, header: column.label, width: column.width, sortKey: column.sortKey, cell: CELLS[column.key],
    })),
    {
      key: "menu", header: <span className="sr-only">Actions</span>, width: 40, align: "right",
      cell: (row) => (
        <span onClick={(event) => event.stopPropagation()} className="inline-flex">
          <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${row.full_name ?? "this contact"}`} size={24} />} width={196}>
            <MenuItem icon={UserRound} onSelect={() => onOpen(row)}>Open profile</MenuItem>
            {row.linkedin_url ? <MenuItem icon={ExternalLink} onSelect={() => window.open(row.linkedin_url!, "_blank", "noopener,noreferrer")}>Open on LinkedIn</MenuItem> : null}
            {row.email ? <MenuItem icon={Copy} onSelect={() => void copyEmail(row.email!)}>Copy email address</MenuItem> : null}
            {canEdit ? (
              <>
                <MenuSeparator />
                <MenuItem icon={ListPlus} onSelect={() => onAction("list", row)}>{labels?.list ?? "Add to list"}</MenuItem>
                <MenuItem icon={Tag} onSelect={() => onAction("tag", row)}>Tag</MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" onSelect={() => onAction("delete", row)}>{labels?.delete ?? "Delete"}</MenuItem>
              </>
            ) : null}
          </Menu>
        </span>
      ),
    },
  ];
}
