import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/router";
import { ArrowLeft, ArrowRight, FileQuestion, Lock, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { Page } from "@/components/shell";
import { Button, Card, EmptyState, ErrorState, Pill, Skeleton, Steps, Tooltip, confirm } from "@/components/ui";
import { ApiError, api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { FileCard } from "./FileCard";
import { MappingCard } from "./MappingCard";
import { DuplicateCard, ImportIntoCard, TemplateCard, ValidationCard, type Change } from "./SidePanel";
import { DuplicatesStep, ResultPanel, ReviewStep } from "./StepPanels";
import { UploadStep } from "./UploadStep";
import {
  STEPS, checkPath, continueLabel, importHref, importPath, mappingProblem, newImportHref, nextStep, previousStep, runPath, stepIndex, stepMeta, stepSubs, withChange,
  type ImportCheck, type ImportStep, type ImportView, type PageStep, type StoredResult,
} from "./model";


/**
 * Audience → Lists → Import contacts: a CSV file into a list in four steps. The import is
 * kept from the moment its file is read, and every change after that as it is made, so the
 * page can be left at any step and opened again.
 */
export function ImportScreen() {
  const t = useTranslations("CsvImport");
  const locale = useLocale();
  const router = useRouter();
  const cache = useSWRConfig();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const listId = typeof router.query.list === "string" ? router.query.list : null;
  const canImport = useCan("member");
  const isNew = id === "new";

  const { data, error, isLoading, mutate } = useApi<{ import: ImportView }>(router.isReady && canImport && id && !isNew ? importPath(id) : null, undefined, { revalidateOnFocus: false });
  const view = data?.import ?? null;
  const draft = view?.status === "draft" ? view : null;

  // The dry run is asked for again after every change that is kept.
  const [revision, setRevision] = useState(0);
  const checked = useApi<ImportCheck>(draft ? checkPath(draft.id) : null, { r: revision }, { keepPreviousData: true, revalidateOnFocus: false });
  const check = draft ? checked.data ?? null : null;
  const checking = Boolean(draft) && (checked.isLoading || checked.isValidating);

  // Changes are sent one after another, so a slow answer never overwrites a later choice.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(0);
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const importId = view?.id ?? null;

  const save = useCallback((change: Change): Promise<boolean> => {
    if (!importId) return Promise.resolve(false);
    const mine = ++latest.current;
    void mutate((current) => (current ? { import: withChange(current.import, change) } : current), { revalidate: false });
    setPending((count) => count + 1);
    const sent = queue.current.then(async () => {
      try {
        const next = await api<{ import: ImportView }>(importPath(importId), { method: "PATCH", body: change });
        if (latest.current === mine) await mutate(next, { revalidate: false });
        setRevision((count) => count + 1);
        return true;
      } catch (cause) {
        toast.error(errorMessage(cause));
        await mutate();
        return false;
      } finally {
        setPending((count) => count - 1);
      }
    });
    queue.current = sent;
    return sent;
  }, [importId, mutate]);

  async function started(made: ImportView) {
    // The page of the new import opens with what the upload answered, without asking again.
    await cache.mutate(apiUrl(importPath(made.id)), { import: made }, { revalidate: false });
    await router.replace(importHref(made.id));
  }

  async function discard() {
    if (!draft) return void router.push("/lists");
    const ok = await confirm({ title: t("discardTitle", {name: draft.file.name}), body: t("discardBody"), confirmLabel: t("discardAction"), tone: "danger" });
    if (!ok) return;
    try {
      await queue.current;
      await api(importPath(draft.id), { method: "DELETE" });
      toast.success(t("discarded"));
      await router.push("/lists");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function saveAndExit() {
    await queue.current;
    toast.success(t("saved"), { description: t("savedHint") });
    await router.push("/lists");
  }

  async function run() {
    if (!draft || running) return;
    setRunning(true);
    try {
      await queue.current;
      const done = await api<{ import: ImportView; result: StoredResult }>(runPath(draft.id), { method: "POST" });
      await mutate({ import: done.import }, { revalidate: false });
    } catch (cause) {
      toast.error(errorMessage(cause));
      setRevision((count) => count + 1);
    } finally {
      setRunning(false);
    }
  }

  const step: PageStep = draft ? draft.step : "upload";
  const current = view?.status === "done" ? STEPS.length : stepIndex(step);
  const subs = locale === "pt-BR"
    ? !view ? {
        upload: t("subUpload"), map: t("subMap"), duplicates: t("subDuplicates"), review: t("subReview"),
      } : view.status === "done" && view.result ? {
        upload: view.file.name,
        map: t("columnsCount", {count: view.file.columns}),
        duplicates: view.result.skipped ? t("excludedCount", {count: view.result.skipped}) : t("updatedCount", {count: view.result.updated}),
        review: t("importedCount", {count: view.result.rows - view.result.skipped - view.result.errors}),
      } : {
        upload: view.file.name,
        map: t("mappedCount", {count: view.columns.filter((c) => c.mapping.kind !== "ignore").length, total: view.columns.length}),
        duplicates: !check ? t("checking") : !check.duplicate_rows ? t("noDuplicates") : t("matchCount", {count: check.duplicate_rows}),
        review: check ? t("readyCount", {count: check.summary.ready}) : t("checking"),
      }
    : stepSubs(view, check);
  const stepNames = {upload: t("stepUpload"), map: t("stepMap"), duplicates: t("stepDuplicates"), review: t("stepReview")};
  const primaryLabel = draft ? locale !== "pt-BR" ? continueLabel(draft.step, check)
    : draft.step === "map" ? t("continueDuplicates")
      : draft.step === "duplicates" ? t("continueReview")
        : check ? t("importCount", {count: check.summary.ready}) : t("importAction") : "";
  const problem = draft ? mappingProblem(draft) : null;
  const blocked = step === "map" ? problem : step === "review" ? check?.problem ?? null : null;
  const go = (to: ImportStep | null) => { if (to) void save({ step: to }); };

  const primary = draft ? (
    <Button
      variant="primary" icon={step === "review" ? Upload : undefined} iconRight={step === "review" ? undefined : ArrowRight} loading={running}
      disabled={Boolean(blocked) || (step === "review" && (!check || checking || pending > 0))}
      onClick={() => (step === "review" ? void run() : go(nextStep(draft.step)))}
    >
      {primaryLabel}
    </Button>
  ) : null;

  return (
    <Page
      title={t("title")} crumbs={[{label: t("lists"), href: "/lists"}]}
      meta={view?.status === "done" ? <Pill tone="good">{t("imported")}</Pill> : canImport && (isNew || draft) ? <Pill tone="brand">{locale === "pt-BR" ? t("stepMeta", {current: stepIndex(step)+1, total: STEPS.length, name: stepNames[step]}) : stepMeta(step)}</Pill> : null}
      actions={draft ? (
        <>
          <Button variant="ghost" onClick={() => void discard()}>{t("cancel")}</Button>
          <Button icon={Save} onClick={() => void saveAndExit()}>{t("saveExit")}</Button>
          {previousStep(draft.step) ? <Button icon={ArrowLeft} onClick={() => go(previousStep(draft.step))}>{t("back")}</Button> : null}
          {blocked ? <Tooltip label={blocked}><span tabIndex={0} className="inline-flex rounded-md">{primary}</span></Tooltip> : primary}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      ) : isNew && canImport ? <Button asChild variant="ghost"><Link href="/lists">{t("cancel")}</Link></Button> : null}
    >
      {!canImport ? (
        <Card>
          <EmptyState icon={Lock} title={t("roleRequired")} action={<Button asChild><Link href="/lists">{t("backLists")}</Link></Button>}>
            {t("roleHint")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Steps className="shrink-0" current={current} items={STEPS.map((item) => ({ key: item.key, label: locale === "pt-BR" ? stepNames[item.key] : item.label, sub: subs[item.key] }))} />
          {!router.isReady || id === null ? <LoadingLayout /> : isNew ? (
            <UploadStep listId={listId} onStarted={(made) => void started(made)} />
          ) : error && !view ? (
            error instanceof ApiError && error.status === 404 ? (
              <Card>
                <EmptyState icon={FileQuestion} title={t("gone")} action={<Button asChild variant="primary"><Link href={newImportHref()}>{t("importFile")}</Link></Button>}>
                  {t("goneHint")}
                </EmptyState>
              </Card>
            ) : <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>
          ) : isLoading || !view ? <LoadingLayout /> : view.status === "done" && view.result ? (
            <ResultPanel view={view} result={view.result} canCampaign={canImport} />
          ) : draft ? (
            <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-3.5">
                <FileCard view={draft} onReplace={(file) => save(file)} />
                {step === "map" ? <MappingCard view={draft} onMapping={(mapping) => void save({ mapping })} onAutomap={() => void save({ automap: true })} />
                  : step === "duplicates" ? <DuplicatesStep view={draft} check={check} checking={checking} />
                    : <ReviewStep view={draft} check={check} checking={checking || pending > 0} running={running} onRun={() => void run()} />}
              </div>
              <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[356px]">
                <ImportIntoCard key={draft.id} view={draft} check={check} onChange={(change) => void save(change)} />
                <DuplicateCard view={draft} check={check} checking={checking} onChange={(change) => void save(change)} />
                <ValidationCard view={draft} check={check} checking={checking} error={checked.error ? errorMessage(checked.error) : null} onRerun={() => setRevision((count) => count + 1)} />
                <TemplateCard />
              </div>
            </div>
          ) : null}
        </>
      )}
    </Page>
  );
}

function LoadingLayout() {
  const t = useTranslations("CsvImport");
  return (
    <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label={t("loading")}>
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-[520px] rounded-lg" />
      </div>
      <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[356px]">
        <Skeleton className="h-[185px] rounded-lg" />
        <Skeleton className="h-[283px] rounded-lg" />
        <Skeleton className="h-[200px] rounded-lg" />
      </div>
    </div>
  );
}
