import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Copy, Ellipsis, ExternalLink, ListPlus, Tag, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Avatar, IconButton, Menu, MenuItem, MenuSeparator, Pill, TONE_SOLID, TONE_TEXT, Tooltip, type Column } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatDate, parseTime } from "@/lib/client/format";
import { formatAgeByLocale } from "@/lib/client/localize-relative";
import {
  COLUMNS, LINKEDIN_LABEL, campaignTone, emailState, intentTone, lastActivityLabel, listsSummary, tagTone,
  type ColumnKey, type ContactRow, type EmailKind,
} from "./model";

const DASH = <span className="text-ink-3">—</span>;
const EMAIL_ICON: Record<EmailKind, LucideIcon> = { verified: CircleCheck, checked: CircleCheck, catchall: CircleAlert, invalid: CircleX, unverified: CircleHelp, unchecked: CircleDashed };

export type RowAction = "list" | "tag" | "delete";

/** Name and title, with the name a link so the profile can be reached by keyboard. */
function Identity({ row, href, onVisit }: { row: ContactRow; href: string; onVisit: () => void }) {
  const t = useTranslations("ContactCells");
  const name = row.full_name?.trim() || t("noName");
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
  const t = useTranslations("ContactCells");
  if (!row.email) return DASH;
  const state = emailState(row.email_status);
  const Glyph = EMAIL_ICON[state.kind];
  const statusTitles: Record<EmailKind, string> = {
    verified: t("emailVerified"), checked: t("emailChecked"),
    catchall: t("emailCatchall"), invalid: t("emailInvalid"),
    unverified: t("emailUnverified"), unchecked: t("emailUnchecked"),
  };
  const title = statusTitles[state.kind];
  return (
    <div className="flex min-w-0 items-center gap-[5px]">
      <Tooltip label={title}>
        <span className={cn("inline-flex shrink-0", state.tone === "neutral" ? "text-ink-3" : TONE_TEXT[state.tone], state.kind === "checked" && "opacity-60")}>
          <Glyph size={12} aria-label={title} />
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

function LinkedinCell({ row }: { row: ContactRow }) {
  const t = useTranslations("ContactCells");
  const status = LINKEDIN_LABEL[row.linkedin_status];
  const labels: Record<string, string> = {
    connected: t("connected"), invite_sent: t("inviteSent"),
    inmail_sent: t("inmailSent"), withdrawn: t("withdrawn"),
    not_connected: t("notConnected"),
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-1.5 shrink-0 rounded-full", TONE_SOLID[status.tone])} aria-hidden="true" />
      <span className={cn("truncate text-11", row.linkedin_status === "not_connected" ? "text-ink-3" : "text-ink-2")}>{labels[row.linkedin_status] ?? status.label}</span>
    </span>
  );
}

function ActivityCell({ value }: { value: string | null }) {
  const locale = useLocale();
  const t = useTranslations("ContactCells");
  if (!value) return <span className="text-11 text-ink-3">—</span>;
  const english = lastActivityLabel(value);
  const formatted = formatAgeByLocale(value, locale);
  return <span className="text-11 text-ink-3">{locale === "pt-BR" && formatted === "agora" ? t("justNow") : locale === "pt-BR" ? formatted : english}</span>;
}

function CreatedCell({ value }: { value: string | null }) {
  const locale = useLocale();
  const date = parseTime(value);
  const formatted = locale === "pt-BR" && date ? date.toLocaleDateString("pt-BR", {day: "numeric", month: "short", year: "numeric"}) : formatDate(value);
  return <span className="text-11 text-ink-3">{formatted}</span>;
}

function ColumnHeader({ column }: { column: ColumnKey | "contact" | "actions" }) {
  const t = useTranslations("ContactCells");
  const labels: Record<ColumnKey | "contact" | "actions", string> = {
    contact: t("contact"), company: t("company"), email: t("email"),
    linkedin: "LinkedIn", list: t("list"), campaign: t("campaign"),
    intent: t("intent"), owner: t("owner"), tags: t("tags"),
    last_activity: t("lastActivity"), location: t("location"),
    phone: t("phone"), created: t("created"), actions: t("actions"),
  };
  return <span className={column === "actions" ? "sr-only" : ""}>{labels[column]}</span>;
}

function ContactMenu({ row, canEdit, labels, onOpen, onAction }: {
  row: ContactRow; canEdit: boolean; labels?: {list?: string; delete?: string};
  onOpen: (row: ContactRow) => void;
  onAction: (action: RowAction, row: ContactRow) => void;
}) {
  const t = useTranslations("ContactCells");
  async function copyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      toast.success(t("emailCopied"));
    } catch {
      toast.error(t("emailCopyFailed"));
    }
  }
  return (
    <span onClick={(event) => event.stopPropagation()} className="inline-flex">
      <Menu trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name: row.full_name ?? t("thisContact")})} size={24} />} width={196}>
        <MenuItem icon={UserRound} onSelect={() => onOpen(row)}>{t("openProfile")}</MenuItem>
        {row.linkedin_url ? <MenuItem icon={ExternalLink} onSelect={() => window.open(row.linkedin_url!, "_blank", "noopener,noreferrer")}>{t("openLinkedin")}</MenuItem> : null}
        {row.email ? <MenuItem icon={Copy} onSelect={() => void copyEmail(row.email!)}>{t("copyEmail")}</MenuItem> : null}
        {canEdit ? (
          <>
            <MenuSeparator />
            <MenuItem icon={ListPlus} onSelect={() => onAction("list", row)}>{labels?.list ?? t("addList")}</MenuItem>
            <MenuItem icon={Tag} onSelect={() => onAction("tag", row)}>{t("tag")}</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} tone="danger" onSelect={() => onAction("delete", row)}>{labels?.delete ?? t("delete")}</MenuItem>
          </>
        ) : null}
      </Menu>
    </span>
  );
}

const CELLS: Record<ColumnKey, (row: ContactRow) => React.ReactNode> = {
  company: (row) => (row.company ? <span className="text-115 font-medium text-ink-2">{row.company}</span> : DASH),
  email: (row) => <Email row={row} />,
  linkedin: (row) => <LinkedinCell row={row} />,
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
  last_activity: (row) => <ActivityCell value={row.last_activity_at} />,
  location: (row) => (row.location ? <span className="text-11 text-ink-2">{row.location}</span> : DASH),
  phone: (row) => (row.phone ? <span className="text-11 tabular-nums text-ink-2">{row.phone}</span> : DASH),
  created: (row) => <CreatedCell value={row.created_at} />,
};

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
    { key: "contact", header: <ColumnHeader column="contact" />, sortKey: "name", cell: (row) => <Identity row={row} href={profileHref(row)} onVisit={onVisit} /> },
    ...COLUMNS.filter((column) => shown.includes(column.key)).map((column): Column<ContactRow> => ({
      key: column.key, header: <ColumnHeader column={column.key} />, width: column.width, sortKey: column.sortKey, cell: CELLS[column.key],
    })),
    {
      key: "menu", header: <ColumnHeader column="actions" />, width: 40, align: "right",
      cell: (row) => <ContactMenu row={row} canEdit={canEdit} labels={labels} onOpen={onOpen} onAction={onAction} />,
    },
  ];
}
