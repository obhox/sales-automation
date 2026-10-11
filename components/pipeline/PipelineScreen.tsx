import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { useSWRConfig } from "swr";
import { ChevronDown, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, ErrorState, OptionPicker, Segmented, confirm } from "@/components/ui";
import { Page } from "@/components/shell";
import { errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { ActivityView, LogActivityDialog, RecentActivity } from "./Activity";
import { deleteOpportunity, updateOpportunity } from "./api";
import { Board } from "./Board";
import { MeetingsView, UpcomingMeetings } from "./Meetings";
import { OpportunityDialog, type OpportunityDraft } from "./OpportunityDialog";
import { StagesDialog } from "./StagesDialog";
import { SummaryStrip } from "./SummaryStrip";
import { TaskDialog, TasksCard, TasksView, type TaskDraft } from "./Tasks";
import {
  CONNECTIONS_PATH, PIPELINE_PATH, VIEWS, calendarReturnNotice, columnsOf, crmSyncNote, ownerLabel, ownerOptions, viewOf,
  type ConnectionRow, type Opportunity, type PipelineData, type View,
} from "./model";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
/** Everything the page shows is read from under these; a write reads them all again. */
const READS = [PIPELINE_PATH, "/api/pipeline/", CONNECTIONS_PATH, "/api/shell"];
/** What a list keeps in the address bar, and what coming back from a calendar sign-in leaves there. Dropped when the view changes. */
const VIEW_STATE = ["page", "per", "sort", "q", "status", "priority", "due", "when", "match", "group", "calendars", "calendar", "calendar_error", "provider"];

/**
 * The pipeline: the board of opportunities by stage with its figures, and beside it the
 * tasks, the meetings and what has happened. Each of those also has a view of its own.
 */
export function PipelineScreen() {
  const router = useRouter();
  const { data: session } = useSession();
  const { mutate } = useSWRConfig();
  const me = session?.user?.id ?? null;
  const canEdit = useCan("member");
  const canManage = useCan("manager");
  const canAdmin = useCan("admin");

  const view = viewOf(first(router.query.view));
  const owner = first(router.query.owner) || "all";
  const pipeline = useApi<PipelineData>(router.isReady ? PIPELINE_PATH : null, owner === "all" ? undefined : { owner });
  const connections = useApi<ConnectionRow[]>(view === "board" ? CONNECTIONS_PATH : null);
  const data = pipeline.data;

  const [opportunity, setOpportunity] = useState<OpportunityDraft | null>(null);
  const [task, setTask] = useState<TaskDraft | null>(null);
  const [editingStages, setEditingStages] = useState(false);
  const [logging, setLogging] = useState(false);

  const refresh = useCallback(() => {
    void mutate((key) => typeof key === "string" && READS.some((path) => key.startsWith(path)));
  }, [mutate]);

  const setQuery = useCallback((change: Record<string, string | undefined>, drop: string[] = []) => {
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries({ ...router.query, ...change })) if (value !== undefined && value !== "" && !drop.includes(key)) query[key] = value;
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false });
  }, [router]);
  const setView = (next: View) => setQuery({ view: next === "board" ? undefined : next }, VIEW_STATE);

  const columns = useMemo(() => (data ? columnsOf(data.stages, data.opportunities, data.summary.currency) : undefined), [data]);
  const notice = calendarReturnNotice(router.query);

  async function move(deal: Opportunity, stageId: string) {
    if (!data) return;
    const stage = data.stages.find((item) => item.id === stageId);
    // The card moves at once; the figures and the activity list follow when the server has answered.
    const moved: PipelineData = { ...data, opportunities: data.opportunities.map((item) => (item.id === deal.id ? { ...item, stage_id: stageId } : item)) };
    try {
      await pipeline.mutate(async () => { await updateOpportunity(deal.id, { stage_id: stageId }); return undefined; }, { optimisticData: moved, populateCache: false, rollbackOnError: true, revalidate: true });
      toast.success(`${deal.name} moved to ${stage?.name ?? "the stage"}`);
      refresh();
    } catch (cause) { toast.error(errorMessage(cause)); }
  }

  async function remove(deal: Opportunity) {
    if (!(await confirm({ title: `Delete ${deal.name}?`, body: "Its tasks and meetings are kept, without the link to it. This cannot be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await deleteOpportunity(deal.id);
      toast.success("Opportunity deleted");
      refresh();
    } catch (cause) { toast.error(errorMessage(cause)); }
  }

  const members = data?.members ?? [];
  return (
    <Page
      title="Pipeline"
      meta={<Segmented label="View" value={view} onChange={setView} options={[...VIEWS]} />}
      actions={
        <>
          {view === "meetings" ? null : (
            <OptionPicker
              label={view === "tasks" ? "Show tasks assigned to" : view === "activity" ? "Show activity by" : "Show opportunities owned by"} align="end" width={220}
              value={owner} onChange={(next) => setQuery({ owner: next === "all" ? undefined : next }, ["page"])} options={ownerOptions(members)}
              trigger={<Button icon={UserRound} iconRight={ChevronDown}>{ownerLabel(owner, members)}</Button>}
            />
          )}
          {canEdit ? <Button variant="primary" icon={Plus} onClick={() => setOpportunity({ mode: "new", stageId: null })}>New opportunity</Button> : null}
        </>
      }
    >
      {view === "board" ? (
        pipeline.error && !data ? (
          <Card><ErrorState message={errorMessage(pipeline.error)} onRetry={() => void pipeline.mutate()} /></Card>
        ) : (
          <>
            <SummaryStrip summary={data?.summary} />
            <Board
              columns={columns} currency={data?.summary.currency ?? "USD"} canEdit={canEdit} canManage={canManage}
              syncNote={connections.data ? crmSyncNote(connections.data) : null}
              onAdd={(stageId) => setOpportunity({ mode: "new", stageId })} onOpen={(deal) => setOpportunity({ mode: "edit", opportunity: deal })}
              onMove={(deal, stageId) => void move(deal, stageId)} onDelete={(deal) => void remove(deal)} onEditStages={() => setEditingStages(true)}
            />
            <div className="flex shrink-0 items-start gap-3.5">
              <TasksCard owner={owner} canEdit={canEdit} onChanged={refresh} onEdit={setTask} onViewAll={() => setView("tasks")} />
              <Card className="flex w-[352px] shrink-0 flex-col">
                <UpcomingMeetings canAdmin={canAdmin} onCalendars={() => setView("meetings")} />
                <RecentActivity owner={owner} canEdit={canEdit} onLog={() => setLogging(true)} onViewAll={() => setView("activity")} />
              </Card>
            </div>
          </>
        )
      ) : null}
      {view === "tasks" ? <TasksView owner={owner} canEdit={canEdit} onChanged={refresh} onEdit={setTask} /> : null}
      {view === "meetings" ? (
        <MeetingsView canEdit={canEdit} canAdmin={canAdmin} notice={notice} onDismissNotice={() => setQuery({}, ["calendars", "calendar", "calendar_error", "provider"])} onChanged={refresh} />
      ) : null}
      {view === "activity" ? <ActivityView owner={owner} canEdit={canEdit} onLog={() => setLogging(true)} /> : null}

      {opportunity && data ? (
        <OpportunityDialog draft={opportunity} stages={data.stages} members={members} sources={data.sources} currency={data.summary.currency} me={me} onClose={() => setOpportunity(null)} onSaved={refresh} />
      ) : null}
      {editingStages && data ? <StagesDialog stages={data.stages} autoOpportunity={data.settings.auto_opportunity_on_reply} onClose={() => setEditingStages(false)} onChanged={refresh} /> : null}
      {task ? <TaskDialog draft={task} members={members} opportunities={data?.opportunities ?? []} me={me} onClose={() => setTask(null)} onSaved={refresh} /> : null}
      {logging ? <LogActivityDialog onClose={() => setLogging(false)} onSaved={refresh} /> : null}
    </Page>
  );
}
