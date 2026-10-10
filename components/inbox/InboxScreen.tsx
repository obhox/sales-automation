import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { useSWRConfig } from "swr";
import { Bookmark, CheckCheck, ChevronDown, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, Pill } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative } from "@/lib/client/format";
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
      if (sync.data?.email.check.status === "error") toast.error(`The mailboxes could not be read: ${sync.data.email.check.error ?? "unknown error"}`);
      else toast.success(found > 0 ? `${found} new ${found === 1 ? "reply" : "replies"}` : "No new replies");
    }
    wasRunning.current = running;
  }, [running, sync.data, refreshList]);

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
      if (started.email.mailboxes === 0 && started.linkedin.accounts === 0) toast.message("Nothing to check", { description: "No mailbox with IMAP and no signed-in LinkedIn account reads replies in this workspace." });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  async function readAll() {
    try {
      const { marked } = await markAllRead();
      toast.success(marked ? `${formatCount(marked)} marked as read` : "Everything was already read");
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
      title="Inbox" padded={false}
      meta={
        <>
          {totals && totals.unread > 0 ? (
            <button type="button" onClick={() => table.set({ filters: { view: table.filters.view === "unread" ? "all" : "unread" } })} aria-pressed={table.filters.view === "unread"} title="Show what you have not read" className="rounded-full">
              <Pill tone="brand">{formatCount(totals.unread)} unread</Pill>
            </button>
          ) : null}
          {totals && totals.overdue > 0 ? (
            <button type="button" onClick={() => table.set({ filters: { sla: table.filters.sla === "overdue" ? "" : "overdue" } })} aria-pressed={table.filters.sla === "overdue"} title="Show conversations with an answer overdue" className="rounded-full">
              <Pill tone="bad">{formatCount(totals.overdue)} overdue SLA</Pill>
            </button>
          ) : null}
        </>
      }
      actions={
        <>
          <Button variant="ghost" icon={RefreshCw} loading={checking || running} disabled={!canEdit} onClick={() => void check()} title={canEdit ? "Check for replies now" : "A member can check for replies"} className="px-2.5">
            {running ? "Checking for replies" : lastChecked ? `Synced ${formatRelative(lastChecked)}` : "Check for replies"}
          </Button>
          <Menu
            width={240}
            trigger={
              <Button aria-label="Saved views">
                <Bookmark size={14} className="text-ink-2" aria-hidden="true" />
                <span className="max-w-[150px] truncate">{activeView?.name ?? (filtered ? "Filtered" : "All replies")}</span>
                <ChevronDown size={13} className="text-ink-2" aria-hidden="true" />
              </Button>
            }
          >
            <MenuChoice checked={!filtered} onSelect={() => applyView(null)}>All replies</MenuChoice>
            {savedViews.length > 0 ? <MenuLabel>Saved views</MenuLabel> : null}
            {savedViews.map((view) => <MenuChoice key={view.id} checked={view.id === activeView?.id} onSelect={() => applyView(view)}>{view.name}</MenuChoice>)}
            {canEdit ? (<><MenuSeparator /><MenuItem icon={Bookmark} onSelect={() => setDialog("views")}>Save or manage views…</MenuItem></>) : null}
          </Menu>
          {canEdit ? <Button icon={CheckCheck} disabled={!totals || totals.unread === 0} onClick={() => void readAll()}>Mark all read</Button> : null}
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
          conversationId={selectedId} meta={meta.data} me={me} role={role} canEdit={canEdit} hasConversations={(list.data?.total ?? 0) > 0}
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
