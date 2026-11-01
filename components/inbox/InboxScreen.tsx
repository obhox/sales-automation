import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import {useLocale, useTranslations} from "next-intl";
import { useSession } from "next-auth/react";
import { useSWRConfig } from "swr";
import { Bookmark, ChevronDown, ListFilter, MailCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, Pill } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import { useCan, useRole } from "@/lib/client/roles";
import { useTableState } from "@/lib/client/table-state";
import { checkReplies, markAllRead } from "./api";
import { ConversationList } from "./ConversationList";
import { BookingLinkDialog, RelinkDialog, SavedRepliesDialog, SavedViewsDialog, TagManagerDialog } from "./Dialogs";
import { FilterRail } from "./FilterRail";
import { MenuChoice } from "./MenuChoice";
import { ThreadPane } from "./ThreadPane";
import {
  FILTER_DEFAULTS, LIST_PATH, META_PATH, SYNC_PATH, VIEWS_PATH, sameView,
  type ConversationDetail, type ConversationsResponse, type FilterKey, type InboxMeta, type InboxSyncStatus, type SavedView, type ViewState,
} from "./model";

const TABLE = { pageSize: 25, sort: { key: "recent", direction: "desc" as const }, filters: FILTER_DEFAULTS };

/** Workspace → Inbox: every conversation with a contact who has written back, read and answered in one place. */
export function InboxScreen() {
  const t = useTranslations("Inbox");
  const locale = useLocale();
  const router = useRouter();
  const { data: session } = useSession();
  const { mutate: mutateAny } = useSWRConfig();
  const role = useRole();
  const canEdit = useCan("member");
  const canShare = useCan("manager");
  const table = useTableState(TABLE);
  const selectedId = typeof router.query.c === "string" && router.query.c ? router.query.c : null;

  const list = useApi<ConversationsResponse>(table.ready ? LIST_PATH : null, table.apiQuery);
  const meta = useApi<InboxMeta>(META_PATH);
  const views = useApi<{ views: SavedView[] }>(VIEWS_PATH, { resource: "inbox" });
  // Asked again only while a check for replies is running, which is what the old inbox did too.
  const sync = useApi<InboxSyncStatus>(SYNC_PATH, undefined, { refreshInterval: (latest) => (latest?.email.check.status === "running" || (latest?.linkedin.requested ?? 0) > 0 ? 4000 : 0) });

  const [dialog, setDialog] = useState<null | "tags" | "replies" | "views" | "booking">(null);
  const [relinking, setRelinking] = useState<ConversationDetail | null>(null);
  const [checking, setChecking] = useState(false);
  const [, tick] = useState(0);

  const me = meta.data?.me ?? session?.user?.id ?? null;
  const sortValue = `${table.sort.key}:${table.sort.direction}`;
  const current: ViewState = {
    filters: Object.fromEntries(Object.entries(table.filters).filter(([key, value]) => value !== FILTER_DEFAULTS[key as FilterKey])),
    ...(sortValue !== "recent:desc" ? { sort: sortValue } : {}), ...(table.search ? { q: table.search } : {}),
  };
  const filtered = table.activeFilterCount > 0 || table.search !== "";
  const savedViews = views.data?.views ?? [];
  const activeView = filtered ? savedViews.find((view) => sameView(view.state, table.filters, sortValue, table.search)) ?? null : null;

  const refreshList = useCallback(() => { void list.mutate(); void mutateAny("/api/shell"); }, [list, mutateAny]);
  const select = useCallback((id: string | null) => {
    const { c: _gone, ...rest } = router.query;
    void _gone;
    void router.replace({ pathname: router.pathname, query: id ? { ...rest, c: id } : rest }, undefined, { shallow: true, scroll: false });
  }, [router]);

  // With nothing chosen, the first conversation in the list is opened, as a mail client does.
  const firstId = list.data?.conversations[0]?.id ?? null;
  useEffect(() => {
    if (!selectedId && firstId && router.isReady) select(firstId);
  }, [selectedId, firstId, router.isReady, select]);

  // When a check for replies that was running has finished, what it found is shown.
  const wasRunning = useRef(false);
  const running = sync.data?.email.check.status === "running" || (sync.data?.linkedin.requested ?? 0) > 0;
  useEffect(() => {
    if (wasRunning.current && !running) {
      refreshList();
      const found = sync.data?.email.check.result?.replies ?? 0;
      if (sync.data?.email.check.status === "error") toast.error(t("checkFailed", {error: sync.data.email.check.error ?? t("unknownError")}));
      else toast.success(found > 0 ? t("newReplies", {count: found}) : t("noNewReplies"));
    }
    wasRunning.current = running;
  }, [running, sync.data, refreshList, t]);

  // "Synced 40s ago" has to keep counting.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function check() {
    setChecking(true);
    try {
      const started = await checkReplies();
      void sync.mutate(started, { revalidate: false });
      if (started.email.mailboxes === 0 && started.linkedin.accounts === 0) toast.message(t("nothingToCheck"), { description: t("nothingToCheckDesc") });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  async function readAll() {
    try {
      const { marked } = await markAllRead();
      toast.success(marked ? t("markedRead", {count: formatCount(marked)}) : t("alreadyRead"));
      refreshList();
      if (selectedId) void mutateAny(`/api/conversations/${encodeURIComponent(selectedId)}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  function applyView(view: SavedView | null) {
    const [key, direction] = (view?.state.sort ?? "recent:desc").split(":");
    table.set({ filters: { ...FILTER_DEFAULTS, ...(view?.state.filters ?? {}) }, sort: { key, direction: direction === "asc" ? "asc" : "desc" }, search: view?.state.q ?? "" });
  }

  const facets = list.data?.facets;
  const totals = list.data?.totals;
  const lastChecked = sync.data?.last_checked_at ?? null;

  return (
    <Page
      title={t("title")} padded={false}
      meta={
        <>
          {totals && totals.unread > 0 ? (
            <button type="button" onClick={() => table.set({ filters: { view: table.filters.view === "unread" ? "all" : "unread" } })} aria-pressed={table.filters.view === "unread"} title={t("showUnread")} className="rounded-full">
              <Pill tone="brand">{t("unread", {count: formatCount(totals.unread)})}</Pill>
            </button>
          ) : null}
          {totals && totals.overdue > 0 ? (
            <button type="button" onClick={() => table.set({ filters: { sla: table.filters.sla === "overdue" ? "" : "overdue" } })} aria-pressed={table.filters.sla === "overdue"} title={t("showOverdue")} className="rounded-full">
              <Pill tone="bad">{t("overdue", {count: formatCount(totals.overdue)})}</Pill>
            </button>
          ) : null}
        </>
      }
      actions={
        <>
          <Button variant="ghost" icon={RefreshCw} loading={checking || running} disabled={!canEdit} onClick={() => void check()} title={canEdit ? t("checkNow") : t("canCheck")} className="px-2.5">
            {running ? t("checking") : lastChecked ? t("synced", {relative: formatRelativeByLocale(lastChecked, locale)}) : t("check")}
          </Button>
          <Menu
            width={240}
            trigger={
              <Button aria-label={t("savedViews")}>
                <ListFilter size={14} className="text-ink-2" aria-hidden="true" />
                <span className="max-w-[150px] truncate">{activeView?.name ?? (filtered ? t("filtered") : t("allReplies"))}</span>
                <ChevronDown size={13} className="text-ink-2" aria-hidden="true" />
              </Button>
            }
          >
            <MenuChoice checked={!filtered} onSelect={() => applyView(null)}>{t("allReplies")}</MenuChoice>
            {savedViews.length > 0 ? <MenuLabel>{t("savedViews")}</MenuLabel> : null}
            {savedViews.map((view) => <MenuChoice key={view.id} checked={view.id === activeView?.id} onSelect={() => applyView(view)}>{view.name}</MenuChoice>)}
            {canEdit ? (<><MenuSeparator /><MenuItem icon={Bookmark} onSelect={() => setDialog("views")}>{t("saveViews")}</MenuItem></>) : null}
          </Menu>
          <Button icon={MailCheck} disabled={!totals || totals.unread === 0} onClick={() => void readAll()}>{t("markAllRead")}</Button>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 gap-3.5 overflow-x-auto p-5">
        <div className={cn("hidden h-full shrink-0 lg:block")}>
          <FilterRail
            filters={table.filters} facets={facets} meta={meta.data} me={me} views={savedViews} activeViewId={activeView?.id ?? null}
            onChange={(key, value) => table.set({ filters: { [key]: value } })}
            onReset={() => applyView(null)} onView={(view) => applyView(view.id === activeView?.id ? null : view)} onManageTags={() => setDialog("tags")}
          />
        </div>
        <ConversationList
          data={list.data} error={list.error} loading={list.isLoading || !table.ready} selectedId={selectedId}
          view={table.filters.view === "unread" || table.filters.view === "mine" ? table.filters.view : "all"}
          search={table.search} sort={sortValue} page={table.page} filtered={filtered}
          onView={(view) => table.set({ filters: { view } })}
          onSearch={(search) => table.set({ search })}
          onSort={(value) => { const [key, direction] = value.split(":"); table.set({ sort: { key, direction: direction === "asc" ? "asc" : "desc" } }); }}
          onPage={(page) => table.set({ page })}
          onSelect={select} onRetry={() => void list.mutate()} onReset={() => applyView(null)}
        />
        <ThreadPane
          conversationId={selectedId} meta={meta.data} me={me} role={role} canEdit={canEdit}
          listLoading={!list.data && !list.error} hasConversations={(list.data?.total ?? 0) > 0}
          onChanged={refreshList} onOpenTags={() => setDialog("tags")} onOpenSavedReplies={() => setDialog("replies")}
          onOpenRelink={setRelinking} onOpenBooking={() => setDialog("booking")}
        />
      </div>

      <TagManagerDialog open={dialog === "tags"} tags={meta.data?.tags ?? []} canEdit={canEdit} onClose={() => setDialog(null)} onChanged={() => { void meta.mutate(); refreshList(); if (selectedId) void mutateAny(`/api/conversations/${encodeURIComponent(selectedId)}`); }} />
      <SavedRepliesDialog open={dialog === "replies"} replies={meta.data?.saved_replies ?? []} mergeTags={meta.data?.merge_tags ?? []} canEdit={canEdit} onClose={() => setDialog(null)} onChanged={() => void meta.mutate()} />
      <SavedViewsDialog open={dialog === "views"} views={savedViews} current={current} canShare={canShare} hasFilters={filtered} onClose={() => setDialog(null)} onChanged={() => void views.mutate()} />
      <BookingLinkDialog open={dialog === "booking"} url={meta.data?.booking_url ?? null} onClose={() => setDialog(null)} onSaved={() => void meta.mutate()} />
      <RelinkDialog
        open={relinking !== null} replyId={relinking?.latest_reply?.id ?? null} address={relinking?.conversation.email ?? null}
        onClose={() => setRelinking(null)} onLinked={() => { refreshList(); if (selectedId) void mutateAny(`/api/conversations/${encodeURIComponent(selectedId)}`); }}
      />
    </Page>
  );
}
