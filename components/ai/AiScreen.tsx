import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { FlaskConical, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Alert, Button, Card, EmptyState, ErrorState, Pill, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { ProviderCard } from "./ProviderCard";
import { BreakdownCard, SpendCard } from "./SpendCards";
import { StepSettingsCard } from "./StepSettingsCard";
import { TestDialog } from "./TestDialog";
import { WritingStyleCard } from "./WritingStyleCard";
import { MODELS_PATH, OVERVIEW_PATH, changes, draftFrom, draftProblem, type AiOverview, type Draft, type ModelInfo } from "./model";

// A draft survives a visit to another screen: it is kept for this browser tab, against
// the saved settings it was started from, and dropped once those have changed.
const DRAFT_KEY = "linki.ai.draft";

function storedDraft(workspaceId: string, base: string | null): Draft | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "null") as { workspace?: string; base?: string | null; draft?: Draft } | null;
    return stored && stored.workspace === workspaceId && stored.base === base && stored.draft ? stored.draft : null;
  } catch {
    return null;
  }
}

function keepDraft(workspaceId: string, base: string | null, draft: Draft | null) {
  try {
    if (draft) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ workspace: workspaceId, base, draft }));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Private browsing: the draft simply does not outlive the page.
  }
}

/** Configure → AI & models: the provider key, the models, how messages are written, and what it costs. */
export function AiScreen() {
  const { data, error, isLoading, mutate } = useApi<AiOverview>(OVERVIEW_PATH);
  const refresh = () => void mutate();

  return (
    <AiPage data={data} error={error && !data ? errorMessage(error) : null} loading={isLoading || !data} onRetry={refresh} onChanged={refresh} />
  );
}

function AiPage({ data, error, loading, onRetry, onChanged }: { data: AiOverview | undefined; error: string | null; loading: boolean; onRetry: () => void; onChanged: () => void }) {
  const t = useTranslations("AiScreen");
  if (error) {
    return (
      <Page title={t("title")}>
        <Card><ErrorState message={error} onRetry={onRetry} /></Card>
      </Page>
    );
  }
  if (loading || !data) {
    return (
      <Page title={t("title")}>
        <LoadingLayout />
      </Page>
    );
  }
  if (!data.available) {
    return (
      <Page title={t("title")}>
        <Card>
          <EmptyState icon={Sparkles} title={t("unavailableTitle")}>
            {t("unavailableHelp")}
          </EmptyState>
        </Card>
      </Page>
    );
  }
  // Keyed by what is saved: after a save, or a change made elsewhere, the form starts again from it.
  return <AiForm key={data.config.updated_at ?? "unsaved"} data={data} onChanged={onChanged} />;
}

function AiForm({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const t = useTranslations("AiScreen");
  const { data: session } = useSession();
  const workspaceId = session?.user?.workspaceId ?? "";
  const can = { member: useCan("member"), admin: useCan("admin") };
  const saved = data.config;
  const [draft, setDraft] = useState<Draft>(() => (typeof window === "undefined" ? null : storedDraft(workspaceId, saved.updated_at)) ?? draftFrom(saved));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const pending = useMemo(() => changes(draft, saved), [draft, saved]);
  const dirty = can.admin && Object.keys(pending).length > 0;
  const problem = dirty ? draftProblem(draft, saved) : null;

  const models = useApi<{ models: ModelInfo[] }>(data.provider.connected ? MODELS_PATH : null);
  const modelList = models.data?.models ?? [];
  const modelsError = models.error ? errorMessage(models.error) : null;
  const modelsUnavailable = !data.provider.connected ? t("addKey") : modelsError ?? t("loadingModels");

  useEffect(() => {
    if (workspaceId) keepDraft(workspaceId, saved.updated_at, dirty ? draft : null);
  }, [workspaceId, saved.updated_at, dirty, draft]);

  // Closing or reloading the tab would lose the draft for good.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onDraft = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    if (problem) return toast.error(problem);
    setSaving(true);
    try {
      await api("/api/platform/ai-config", { method: "PUT", body: pending });
      keepDraft(workspaceId, saved.updated_at, null);
      toast.success(t("saved"), { description: t("savedHelp") });
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(draftFrom(saved));
    keepDraft(workspaceId, saved.updated_at, null);
  }

  return (
    <Page
      title={t("title")}
      meta={dirty ? <Pill tone="warn" dot>{t("unsaved")}</Pill> : null}
      actions={
        <>
          {can.admin ? <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>{t("discard")}</Button> : null}
          {can.member ? <Button icon={FlaskConical} disabled={!data.provider.connected} onClick={() => setTesting(true)}>{t("test")}</Button> : null}
          {can.admin ? <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>{t("save")}</Button> : null}
          {can.member ? <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" /> : null}
        </>
      }
    >
      {data.attention.map((notice) => (
        <Alert key={notice.code} banner tone={notice.tone} title={notice.title}>
          {notice.detail}
          {notice.code === "budget_reached" || notice.code === "budget_nearly" ? (can.admin ? t("budgetChange") : t("budgetAdmin")) : ""}
        </Alert>
      ))}
      {!can.admin ? (
        <Alert tone="neutral">
          {can.member ? t("memberHelp") : t("viewerHelp")}
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <ProviderCard overview={data} draft={draft} onDraft={onDraft} models={modelList} modelsError={modelsError} canEdit={can.admin} onKeyChanged={() => { onChanged(); void models.mutate(); }} />
          <WritingStyleCard draft={draft} onDraft={onDraft} canEdit={can.admin} />
          <StepSettingsCard campaigns={data.campaigns} models={modelList} defaultModel={saved.default_model} modelsUnavailable={modelsUnavailable} canEdit={can.member} onChanged={onChanged} />
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[368px]">
          <SpendCard usage={data.usage} draft={draft} onDraft={onDraft} savedBudget={saved.monthly_budget_usd} canEdit={can.admin} />
          <BreakdownCard usage={data.usage} models={modelList} />
        </div>
      </div>

      {can.member ? <TestDialog open={testing} onClose={() => setTesting(false)} draft={draft} dirty={dirty} models={modelList} onTested={onChanged} /> : null}
    </Page>
  );
}

function LoadingLayout() {
  const t = useTranslations("AiScreen");
  return (
    <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label={t("loading")}>
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <Skeleton className="h-[150px] rounded-lg" />
        <Skeleton className="h-[330px] rounded-lg" />
        <Skeleton className="h-[280px] rounded-lg" />
      </div>
      <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[368px]">
        <Skeleton className="h-[230px] rounded-lg" />
        <Skeleton className="h-[330px] rounded-lg" />
      </div>
    </div>
  );
}
