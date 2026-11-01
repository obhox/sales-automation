import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Building2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Meter, Pill, Select, Skeleton, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { plural } from "@/lib/client/format";
import { formatRelativeByLocale, formatDateTimeByLocale } from "@/lib/client/localize-relative";
import { recordHref } from "@/lib/client/nav";
import { RecordPicker, type Picked } from "./RecordPicker";
import {
  DETECTION_PATH, RUN_STATUS, accountLine, costLines, detectionState, previewEstimate, readCap, runCost,
  type DetectionKind, type DetectionOverview,
} from "./model";

/**
 * Checking watched accounts for changes through Apollo. Each look-up costs Apollo
 * credits, so this tab says what a run would cost before anything can be switched on,
 * and nothing here asks Apollo anything until an admin turns it on or presses Run now.
 */
export function DetectionTab({ manager, admin, onSignals }: { manager: boolean; admin: boolean; /** Called when a run has finished, so the feed and its count read again. */ onSignals: () => void }) {
  const t = useTranslations("SignalsDetection");
  const locale = useLocale();
  const { data, error, isLoading, mutate } = useApi<DetectionOverview>(DETECTION_PATH);
  // A run goes on after the request that began it, so the tab keeps reading while one is under way.
  const running = data?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void mutate(), 2500);
    return () => clearInterval(timer);
  }, [running, mutate]);
  // The newest run that has ended. A quick run can end between two reads, so this is what
  // says one has finished, not "it was running and now it is not". The first read is not news.
  const ended = data ? data.runs.find((run) => run.status !== "running")?.id ?? null : undefined;
  const lastEnded = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (ended === undefined) return;
    if (lastEnded.current !== undefined && ended !== lastEnded.current) onSignals();
    lastEnded.current = ended;
  }, [ended, onSignals]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (error && !data) return <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>;
  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label={t("loading")}>
        <Skeleton className="h-[420px] flex-1 rounded-lg" />
        <Skeleton className="h-[300px] w-full rounded-lg xl:w-[420px]" />
      </div>
    );
  }

  async function act(key: string, work: () => Promise<DetectionOverview | void>, done?: string) {
    if (busy) return;
    setBusy(key);
    try {
      const next = await work();
      if (next) void mutate(next, { revalidate: false });
      else void mutate();
      if (done) toast.success(done);
    } catch (cause) {
      toast.error(errorMessage(cause), { duration: 10_000 });
    } finally {
      setBusy(null);
    }
  }

  const unwatch = (companyId: string, name: string) =>
    act(`unwatch:${companyId}`, async () => (await api<{ overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "unwatch", company_ids: [companyId] } })).overview, t("stopped", {name}));

  return (
    <>
      {!admin ? <Alert tone="neutral">{manager ? t("managerHint") : t("viewerHint")}</Alert> : null}
      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <SettingsCard key={`${data.config.enabled}:${data.config.kinds.join()}:${data.config.interval_days}:${data.config.monthly_credit_cap}`} overview={data} admin={admin} busy={busy} act={act} />

          <Card className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("watched")}</h2>
                <p className="text-11 text-ink-3">{t("watchedCount", {count: data.accounts.length, max: data.limits.max_watched})}</p>
              </div>
              {manager ? <Button size="sm" className="h-7 px-3" icon={Plus} onClick={() => setAdding(true)} disabled={data.accounts.length >= data.limits.max_watched}>{t("addAccounts")}</Button> : null}
            </div>
            {data.accounts.length === 0 ? (
              <EmptyState icon={Building2} title={t("emptyWatched")} className="border-t border-line" action={manager ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>{t("addAccounts")}</Button> : undefined}>
                {manager ? t("emptyManager") : t("emptyViewer")}
              </EmptyState>
            ) : (
              <ul className="flex max-h-[420px] flex-col overflow-y-auto">
                {data.accounts.map((account) => (
                  <li key={account.company_id} className="flex items-center gap-3 border-t border-line px-3.5 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link href={recordHref("company", account.company_id)} className="truncate text-12 font-medium text-ink hover:text-brand-strong hover:underline">{account.name}</Link>
                        {account.domain ? <span className="truncate text-105 text-ink-3">{account.domain}</span> : <Pill size="sm" tone="warn">{t("noWebsite")}</Pill>}
                      </div>
                      <span className="truncate text-105 text-ink-3" title={account.last_result ?? undefined}>
                        {accountLine(account)} · {t("contacts", {count: account.contacts})}
                      </span>
                    </div>
                    {manager ? <IconButton icon={Trash2} label={t("stopWatch", {name: account.name})} size={28} disabled={busy !== null} onClick={() => void unwatch(account.company_id, account.name)} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[420px]">
          <Card className="flex flex-col gap-3 p-3.5">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("apolloCredits")}</h2>
              <p className="text-11 text-ink-3">{data.estimate.cap > 0 ? t("spentCount", {used: data.estimate.spent_this_month, cap: data.estimate.cap}) : data.estimate.spent_this_month > 0 ? t("spentNoCap", {used: data.estimate.spent_this_month}) : t("spentNone")}</p>
            </div>
            {data.estimate.cap > 0 ? <Meter value={data.estimate.spent_this_month} max={data.estimate.cap} tone={data.estimate.remaining === 0 ? "bad" : "brand"} label={t("capShare")} /> : null}
            <p className="text-105 leading-[15px] text-ink-3">
              {t("creditHint")}
            </p>
          </Card>

          <Card className="flex flex-col overflow-hidden">
            <div className="flex flex-col gap-0.5 px-3.5 py-[11px]">
              <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("recentRuns")}</h2>
              <p className="text-11 text-ink-3">{data.config.enabled && data.next_run_at ? t("nextRun", {when: formatRelativeFuture(data.next_run_at, locale)}) : t("offSchedule")}</p>
            </div>
            {data.runs.length === 0 ? (
              <p className="border-t border-line px-3.5 py-3 text-115 text-ink-3">{t("noRuns")}</p>
            ) : (
              <ul className="flex flex-col">
                {data.runs.map((run) => {
                  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "neutral" as const };
                  return (
                    <li key={run.id} className="flex flex-col gap-1 border-t border-line px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-115 font-medium text-ink" title={formatDateTimeByLocale(run.started_at, locale)}>{formatRelativeByLocale(run.started_at, locale)} · {t(run.trigger === "manual" ? "byHand" : "scheduled")}</span>
                        <Pill size="sm" tone={status.tone}>{t(run.status === "running" ? "statusRunning" : run.status === "done" ? "statusDone" : run.status === "stopped_at_cap" ? "statusCap" : "statusFailed")}</Pill>
                      </div>
                      <span className="break-words text-105 leading-[15px] text-ink-2">{run.status === "failed" ? run.error ?? t("runFailed") : t("runAccounts", {count: run.accounts_checked}) + " · " + (run.signals_found ? t("runSignals", {count: run.signals_found}) : t("runNothing")) + " · " + t("runCredit", {count: run.credits_spent})}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {adding ? <AddAccountsDialog watched={new Set(data.accounts.map((account) => account.company_id))} onClose={() => setAdding(false)} onAdded={(next, message) => { void mutate(next, { revalidate: false }); toast.success(message); }} /> : null}
    </>
  );
}

/** "in 3 days", "within the hour", "now". */
function formatRelativeFuture(iso: string, locale = "en"): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes <= 0) return locale === "pt-BR" ? "agora, na próxima execução em segundo plano" : "now, at the background loop's next pass";
  if (minutes < 60) return locale === "pt-BR" ? "dentro de uma hora" : "within the hour";
  const hours = Math.round(minutes / 60);
  if (hours < 36) return locale === "pt-BR" ? "em " + hours + (hours === 1 ? " hora" : " horas") : `in ${hours} ${plural(hours, "hour", "hours")}`;
  return locale === "pt-BR" ? "em " + Math.round(hours / 24) + " dias" : `in ${Math.round(hours / 24)} days`;
}

function SettingsCard({ overview, admin, busy, act }: {
  overview: DetectionOverview;
  admin: boolean;
  busy: string | null;
  act: (key: string, work: () => Promise<DetectionOverview | void>, done?: string) => Promise<void>;
}) {
  const t = useTranslations("SignalsDetection");
  const locale = useLocale();
  const { config } = overview;
  const [kinds, setKinds] = useState<DetectionKind[]>(config.kinds);
  const [interval, setIntervalDays] = useState(String(config.interval_days));
  const [cap, setCap] = useState(config.monthly_credit_cap > 0 ? String(config.monthly_credit_cap) : "");
  const [capError, setCapError] = useState<string | null>(null);

  const typedCap = cap.trim() === "" ? { value: 0, error: null } : readCap(cap);
  const shown = previewEstimate(overview.estimate, kinds, Number(interval), typedCap.value ?? 0);
  const changed = kinds.join() !== config.kinds.join() || Number(interval) !== config.interval_days || (typedCap.value ?? 0) !== config.monthly_credit_cap;
  const state = detectionState(overview);
  const intervalName = (days: number) => t(days === 1 ? "daily" : days === 7 ? "weekly" : days === 14 ? "fortnight" : days === 30 ? "monthly" : "everyDays", {count: days});
  const costDetails = shown.accounts === 0 ? [t("costEmpty")] : (() => {
    const skipped = shown.accounts - shown.checkable;
    return [
      t("costRun", {count: shown.checkable, each: shown.credits_per_account, total: shown.credits_per_run}) +
        (skipped > 0 ? t("costSkipped", {count: skipped}) : ""),
      t("costMonth", {interval: intervalName(Number(interval)), count: shown.credits_per_month}),
      shown.cap <= 0 ? t("costNoCap") : !shown.fits ? t("costOver", {cap: shown.cap}) : t("costWithin", {cap: shown.cap}),
    ];
  })();
  const capErrorText = (message: string) => message.startsWith("Enter a whole number") ? t("capInvalid") :
    message.startsWith("The most a cap") ? t("capMax") : message;
  const put = async (body: Record<string, unknown>) => api<DetectionOverview>(DETECTION_PATH, { method: "PUT", body });
  const settings = () => ({ kinds, interval_days: Number(interval), monthly_credit_cap: typedCap.value ?? 0 });

  function checkCap(): boolean {
    if (typedCap.error) { setCapError(capErrorText(typedCap.error)); return false; }
    setCapError(null);
    return true;
  }

  async function turnOn() {
    if (!checkCap()) return;
    const cost = shown;
    const ok = await confirm({
      title: t("turnOnTitle"),
      body: t("turnOnBody", {days: Number(interval), perRun: cost.credits_per_run, perMonth: cost.credits_per_month, cap: cost.cap}),
      confirmLabel: t("turnOn"),
    });
    if (ok) await act("enable", () => put({ ...settings(), enabled: true }), t("detectionOn"));
  }

  async function runNow() {
    const cost = runCost(overview.estimate);
    const ok = await confirm({
      title: t("runTitle"),
      body: t("runBody", {account: cost.partial ? t("partial") : t("accountCount", {count: overview.estimate.checkable}), credits: cost.credits}),
      confirmLabel: t("spendUpTo", {count: cost.credits}),
    });
    if (ok) await act("run", async () => (await api<{ overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "run" } })).overview, t("runStarted"));
  }

  return (
    <Card className="flex flex-col gap-3.5 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("scheduledTitle")}</h2>
          <p className="text-11 leading-[15px] text-ink-3">{t("scheduledSubtitle")}</p>
        </div>
        <Pill tone={state.tone} dot>{t(overview.running ? "checkNow" : !overview.apollo_connected ? "apolloDisconnected" : config.enabled ? "on" : "off")}</Pill>
      </div>

      {!overview.apollo_connected ? (
        <Alert tone="warn" title={t("apolloNotConnected")}>
          {t("apolloHelp")} <Link href="/integrations#apollo" className="font-semibold underline">{t("integrations")}</Link>{t("apolloHelpEnd")}
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-1" disabled={!admin}>
        <legend className="mb-1.5 text-105 font-semibold text-ink-2">{t("lookFor")}</legend>
        {overview.limits.kinds.map((kind) => {
          const id = `detect-${kind}`;
          return (
            <label key={kind} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle">
              <Checkbox id={id} className="mt-px" disabled={!admin} checked={kinds.includes(kind as DetectionKind)} onChange={(on) => setKinds((current) => (overview.limits.kinds as DetectionKind[]).filter((item) => (item === kind ? on : current.includes(item))))} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-115 font-medium text-ink">{t(kind === "funding" ? "funding" : kind === "hiring" ? "hiring" : "technology")}</span>
                <span className="text-105 leading-[14px] text-ink-3">{t(kind === "funding" ? "fundingHint" : kind === "hiring" ? "hiringHint" : "technologyHint")}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <Field label={t("frequency")}>
          {(id) => <Select id={id} className="w-[190px]" disabled={!admin} value={interval} onChange={setIntervalDays} options={overview.limits.interval_days.map((days) => ({ value: String(days), label: intervalName(days) }))} />}
        </Field>
        <Field label={t("monthlyCap")} error={capError} hint={t("capHint")}>
          {(id) => (
            <Input
              id={id} inputMode="numeric" frameClassName="w-[190px]" placeholder={t("noCap")} disabled={!admin} value={cap} invalid={Boolean(capError)}
              onFocus={(event) => event.target.select()} onChange={(event) => { setCap(event.target.value.replace(/[^\d]/g, "")); setCapError(null); }}
              trailing={<span className="shrink-0 pr-1 text-105 text-ink-3">{t("credits")}</span>}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-subtle px-3 py-2.5" role="status" aria-label={t("cost")}>
        <span className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("cost")}</span>
        {(locale === "pt-BR" ? costDetails : costLines(shown, Number(interval))).map((line) => <p key={line} className="text-115 leading-[17px] text-ink-2">{line}</p>)}
        <p className="text-105 leading-[15px] text-ink-3">{t("costHint")}</p>
      </div>

      {admin ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line pt-3.5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <Switch
              checked={config.enabled} disabled={busy !== null || (!config.enabled && !overview.apollo_connected)} label={t("scheduledTitle")}
              onChange={(on) => (on ? void turnOn() : void act("disable", () => put({ enabled: false }), t("detectionOff")))}
            />
            <span className="text-12 font-medium text-ink">{t(config.enabled ? "enabled" : "disabled")}</span>
          </label>
          <div className="flex items-center gap-2">
            {changed ? <Button loading={busy === "save"} disabled={busy !== null} onClick={() => { if (checkCap()) void act("save", () => put(settings()), t("saved")); }}>{t("save")}</Button> : null}
            <Button icon={Play} loading={busy === "run" || overview.running} disabled={busy !== null || overview.running || Boolean(overview.run_problem) || changed} title={changed ? t("saveFirst") : overview.run_problem ?? undefined} onClick={() => void runNow()}>
              {t(overview.running ? "checking" : "runNow")}
            </Button>
          </div>
        </div>
      ) : null}
      {admin && overview.run_problem && !overview.running ? <p className="-mt-1.5 text-105 text-ink-3">{t("runUnavailable")} {overview.run_problem}</p> : null}
    </Card>
  );
}

interface ListOption { id: string; name: string }

/** Choose companies to watch: one at a time by name, or every company the contacts of a list work at. */
function AddAccountsDialog({ watched, onClose, onAdded }: { watched: Set<string>; onClose: () => void; onAdded: (overview: DetectionOverview, message: string) => void }) {
  const t = useTranslations("SignalsDetection");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [listId, setListId] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lists = useApi<ListOption[]>("/api/lists").data;
  const exclude = new Set([...watched, ...picked.map((item) => item.id)]);

  async function add() {
    if (picked.length === 0 && !listId) return setProblem(t("selectOne"));
    setSaving(true);
    setProblem(null);
    try {
      const result = await api<{ added: number; left_out: number; overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "watch", company_ids: picked.map((item) => item.id), ...(listId ? { list_id: listId } : {}) } });
      const message = result.added === 0 ? t("alreadyWatched") : t("addedCount", {count: result.added});
      onAdded(result.overview, result.left_out > 0 ? t("fullList", {message, count: result.left_out}) : message);
      onClose();
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      size="sm"
      icon={Building2}
      title={t("addTitle")}
      description={t("addDesc")}
      footer={
        <>
          <span className="text-105 text-ink-3">{picked.length > 0 ? t("chosen", {count: picked.length}) : ""}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void add()}>{t("add")}</Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem ? <Alert tone="bad">{problem}</Alert> : null}
        <Field label={t("companies")} hint={t("websiteNeeded")}>
          {() => (
            <div className="flex flex-col gap-1.5">
              {picked.map((item) => <RecordPicker key={item.id} kinds={["company"]} value={item} onChange={() => setPicked((current) => current.filter((other) => other.id !== item.id))} placeholder="" />)}
              <RecordPicker kinds={["company"]} value={null} exclude={exclude} onChange={(value) => { if (value) setPicked((current) => [...current, value]); }} placeholder={t("searchCompanies")} />
            </div>
          )}
        </Field>
        <Field label={t("companiesOfList")} aside={t("optional")} hint={t("listHint")}>
          {(id) => <Select id={id} className="w-full" value={listId || "__none"} onChange={(value) => setListId(value === "__none" ? "" : value)} options={[{ value: "__none", label: t("noList") }, ...(lists ?? []).map((list) => ({ value: list.id, label: list.name }))]} />}
        </Field>
      </div>
    </Dialog>
  );
}
