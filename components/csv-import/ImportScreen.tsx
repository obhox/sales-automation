import Link from "next/link";
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
  STEPS, continueLabel, importHref, importPath, mappingProblem, newImportHref, nextStep, previousStep, stepIndex, stepMeta, stepSubs, withChange,
  type ImportCheck, type ImportStep, type ImportView, type PageStep, type StoredResult,
} from "./model";

const LISTS = [{ label: "Lists", href: "/lists" }];

/**
 * Audience → Lists → Import contacts: a CSV file into a list in four steps. The import is
 * kept from the moment its file is read, and every change after that as it is made, so the
 * page can be left at any step and opened again.
 */
export function ImportScreen() {
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
  const checked = useApi<ImportCheck>(draft ? `${importPath(draft.id)}/check` : null, { r: revision }, { keepPreviousData: true, revalidateOnFocus: false });
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
    const ok = await confirm({ title: `Discard the import of ${draft.file.name}?`, body: "The file and what was set up for it are thrown away. Nothing has been imported from it.", confirmLabel: "Discard import", tone: "danger" });
    if (!ok) return;
    try {
      await queue.current;
      await api(importPath(draft.id), { method: "DELETE" });
      toast.success("Import discarded");
      await router.push("/lists");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function saveAndExit() {
    await queue.current;
    toast.success("Import saved", { description: "Pick it up again from Lists, under Import contacts." });
    await router.push("/lists");
  }

  async function run() {
    if (!draft || running) return;
    setRunning(true);
    try {
      await queue.current;
      const done = await api<{ import: ImportView; result: StoredResult }>(`${importPath(draft.id)}/run`, { method: "POST" });
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
  const subs = stepSubs(view, check);
  const problem = draft ? mappingProblem(draft) : null;
  const blocked = step === "map" ? problem : step === "review" ? check?.problem ?? null : null;
  const go = (to: ImportStep | null) => { if (to) void save({ step: to }); };

  const primary = draft ? (
    <Button
      variant="primary" icon={step === "review" ? Upload : undefined} iconRight={step === "review" ? undefined : ArrowRight} loading={running}
      disabled={Boolean(blocked) || (step === "review" && (!check || checking || pending > 0))}
      onClick={() => (step === "review" ? void run() : go(nextStep(draft.step)))}
    >
      {continueLabel(draft.step, check)}
    </Button>
  ) : null;

  return (
    <Page
      title="Import contacts" crumbs={LISTS}
      meta={view?.status === "done" ? <Pill tone="good">Imported</Pill> : canImport && (isNew || draft) ? <Pill tone="brand">{stepMeta(step)}</Pill> : null}
      actions={draft ? (
        <>
          <Button variant="ghost" onClick={() => void discard()}>Cancel</Button>
          <Button icon={Save} onClick={() => void saveAndExit()}>Save &amp; exit</Button>
          {previousStep(draft.step) ? <Button icon={ArrowLeft} onClick={() => go(previousStep(draft.step))}>Back</Button> : null}
          {blocked ? <Tooltip label={blocked}><span tabIndex={0} className="inline-flex rounded-md">{primary}</span></Tooltip> : primary}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      ) : isNew && canImport ? <Button asChild variant="ghost"><Link href="/lists">Cancel</Link></Button> : null}
    >
      {!canImport ? (
        <Card>
          <EmptyState icon={Lock} title="Importing needs the Member role" action={<Button asChild><Link href="/lists">Back to Lists</Link></Button>}>
            You can look at lists and contacts in this workspace. To import a file, ask one of its admins to make you a member.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Steps className="shrink-0" current={current} items={STEPS.map((item) => ({ key: item.key, label: item.label, sub: subs[item.key] }))} />
          {!router.isReady || id === null ? <LoadingLayout /> : isNew ? (
            <UploadStep listId={listId} onStarted={(made) => void started(made)} />
          ) : error && !view ? (
            error instanceof ApiError && error.status === 404 ? (
              <Card>
                <EmptyState icon={FileQuestion} title="This import is not here any more" action={<Button asChild variant="primary"><Link href={newImportHref()}>Import a file</Link></Button>}>
                  It was discarded, or it was started more than 30 days ago and never run. Nothing was imported from it.
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
  return (
    <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label="Loading the import">
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
