import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Building2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Meter, Pill, Select, Skeleton, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatDateTime, formatRelative, plural } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { RecordPicker, type Picked } from "./RecordPicker";
import {
  DETECTION_PATH, INTERVAL_LABEL, KIND_LABEL, RUN_STATUS, accountLine, costLines, detectionState, previewEstimate, readCap, runCost, runLine, spentLine,
  type DetectionKind, type DetectionOverview,
} from "./model";

/**
 * Checking watched accounts for changes through Apollo. Each look-up costs Apollo
 * credits, so this tab says what a run would cost before anything can be switched on,
 * and nothing here asks Apollo anything until an admin turns it on or presses Run now.
 */
export function DetectionTab({ manager, admin, onSignals }: { manager: boolean; admin: boolean; /** Called when a run has finished, so the feed and its count read again. */ onSignals: () => void }) {
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
      <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label="Loading detection">
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
    act(`unwatch:${companyId}`, async () => (await api<{ overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "unwatch", company_ids: [companyId] } })).overview, `${name} is no longer watched`);

  return (
    <>
      {!admin ? <Alert tone="neutral">{manager ? "You can choose which accounts are watched. An admin turns detection on, sets its cap and starts a run, because each of those can spend Apollo credits." : "You can see how detection is set. A manager chooses the accounts; an admin turns it on and sets its cap."}</Alert> : null}
      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <SettingsCard key={`${data.config.enabled}:${data.config.kinds.join()}:${data.config.interval_days}:${data.config.monthly_credit_cap}`} overview={data} admin={admin} busy={busy} act={act} />

          <Card className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Watched accounts</h2>
                <p className="text-11 text-ink-3">{formatCount(data.accounts.length)} of {formatCount(data.limits.max_watched)} · the companies a run asks Apollo about</p>
              </div>
              {manager ? <Button size="sm" className="h-7 px-3" icon={Plus} onClick={() => setAdding(true)} disabled={data.accounts.length >= data.limits.max_watched}>Add accounts</Button> : null}
            </div>
            {data.accounts.length === 0 ? (
              <EmptyState icon={Building2} title="No accounts are watched" className="border-t border-line" action={manager ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add accounts</Button> : undefined}>
                {manager ? "Choose the companies worth keeping an eye on. Only these are looked up, so this list is also what decides the cost." : "A manager chooses which companies are checked."}
              </EmptyState>
            ) : (
              <ul className="flex max-h-[420px] flex-col overflow-y-auto">
                {data.accounts.map((account) => (
                  <li key={account.company_id} className="flex items-center gap-3 border-t border-line px-3.5 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link href={recordHref("company", account.company_id)} className="truncate text-12 font-medium text-ink hover:text-brand-strong hover:underline">{account.name}</Link>
                        {account.domain ? <span className="truncate text-105 text-ink-3">{account.domain}</span> : <Pill size="sm" tone="warn">No website</Pill>}
                      </div>
                      <span className="truncate text-105 text-ink-3" title={account.last_result ?? undefined}>
                        {accountLine(account)} · {formatCount(account.contacts)} {plural(account.contacts, "contact", "contacts")}
                      </span>
                    </div>
                    {manager ? <IconButton icon={Trash2} label={`Stop watching ${account.name}`} size={28} disabled={busy !== null} onClick={() => void unwatch(account.company_id, account.name)} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[420px]">
          <Card className="flex flex-col gap-3 p-3.5">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Apollo credits</h2>
              <p className="text-11 text-ink-3">{spentLine(data.estimate)}</p>
            </div>
            {data.estimate.cap > 0 ? <Meter value={data.estimate.spent_this_month} max={data.estimate.cap} tone={data.estimate.remaining === 0 ? "bad" : "brand"} label="Share of this month's cap used" /> : null}
            <p className="text-105 leading-[15px] text-ink-3">
              Counted by this instance as it asks, in calendar months (UTC). It is what detection has spent here, not your Apollo balance: Apollo&apos;s own count is on your Apollo account.
            </p>
          </Card>

          <Card className="flex flex-col overflow-hidden">
            <div className="flex flex-col gap-0.5 px-3.5 py-[11px]">
              <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Recent runs</h2>
              <p className="text-11 text-ink-3">{data.config.enabled && data.next_run_at ? `The next one is due ${formatRelativeFuture(data.next_run_at)}` : "None is scheduled while detection is off"}</p>
            </div>
            {data.runs.length === 0 ? (
              <p className="border-t border-line px-3.5 py-3 text-115 text-ink-3">No run yet.</p>
            ) : (
              <ul className="flex flex-col">
                {data.runs.map((run) => {
                  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "neutral" as const };
                  return (
                    <li key={run.id} className="flex flex-col gap-1 border-t border-line px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-115 font-medium text-ink" title={formatDateTime(run.started_at)}>{formatRelative(run.started_at)} · {run.trigger === "manual" ? "started by hand" : "on schedule"}</span>
                        <Pill size="sm" tone={status.tone}>{status.label}</Pill>
                      </div>
                      <span className="break-words text-105 leading-[15px] text-ink-2">{runLine(run)}</span>
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
function formatRelativeFuture(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes <= 0) return "now, at the background loop's next pass";
  if (minutes < 60) return "within the hour";
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} ${plural(hours, "hour", "hours")}`;
  return `in ${Math.round(hours / 24)} days`;
}

function SettingsCard({ overview, admin, busy, act }: {
  overview: DetectionOverview;
  admin: boolean;
  busy: string | null;
  act: (key: string, work: () => Promise<DetectionOverview | void>, done?: string) => Promise<void>;
}) {
  const { config } = overview;
  const [kinds, setKinds] = useState<DetectionKind[]>(config.kinds);
  const [interval, setIntervalDays] = useState(String(config.interval_days));
  const [cap, setCap] = useState(config.monthly_credit_cap > 0 ? String(config.monthly_credit_cap) : "");
  const [capError, setCapError] = useState<string | null>(null);

  const typedCap = cap.trim() === "" ? { value: 0, error: null } : readCap(cap);
  const shown = previewEstimate(overview.estimate, kinds, Number(interval), typedCap.value ?? 0);
  const changed = kinds.join() !== config.kinds.join() || Number(interval) !== config.interval_days || (typedCap.value ?? 0) !== config.monthly_credit_cap;
  const state = detectionState(overview);
  const put = async (body: Record<string, unknown>) => api<DetectionOverview>(DETECTION_PATH, { method: "PUT", body });
  const settings = () => ({ kinds, interval_days: Number(interval), monthly_credit_cap: typedCap.value ?? 0 });

  function checkCap(): boolean {
    if (typedCap.error) { setCapError(typedCap.error); return false; }
    setCapError(null);
    return true;
  }

  async function turnOn() {
    if (!checkCap()) return;
    const cost = shown;
    const ok = await confirm({
      title: "Turn on scheduled detection?",
      body: `From now on Linki asks Apollo about your watched accounts ${(INTERVAL_LABEL[Number(interval)] ?? "on a schedule").toLowerCase()}, without anyone pressing anything. Each run uses up to ${formatCount(cost.credits_per_run)} of your Apollo credits (about ${formatCount(cost.credits_per_month)} a month), and stops for the month at ${formatCount(cost.cap)}. The first run starts at the background loop's next pass.`,
      confirmLabel: "Turn on",
    });
    if (ok) await act("enable", () => put({ ...settings(), enabled: true }), "Detection is on");
  }

  async function runNow() {
    const cost = runCost(overview.estimate);
    const ok = await confirm({
      title: "Check the watched accounts now?",
      body: `This asks Apollo about ${cost.partial ? "as many accounts as the rest of this month's cap allows" : `${formatCount(overview.estimate.checkable)} ${plural(overview.estimate.checkable, "account", "accounts")}`} and uses up to ${formatCount(cost.credits)} of your Apollo ${plural(cost.credits, "credit", "credits")}. Credits Apollo has taken cannot be given back.`,
      confirmLabel: `Spend up to ${formatCount(cost.credits)} ${plural(cost.credits, "credit", "credits")}`,
    });
    if (ok) await act("run", async () => (await api<{ overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "run" } })).overview, "The run has started");
  }

  return (
    <Card className="flex flex-col gap-3.5 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Scheduled detection</h2>
          <p className="text-11 leading-[15px] text-ink-3">Asks Apollo, for each watched account, whether it has raised money, started hiring or changed its tools, and records what changed as signals</p>
        </div>
        <Pill tone={state.tone} dot>{state.label}</Pill>
      </div>

      {!overview.apollo_connected ? (
        <Alert tone="warn" title="Apollo is not connected">
          Detection uses your own Apollo account. Add its API key under <Link href="/integrations#apollo" className="font-semibold underline">Integrations</Link>, then come back.
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-1" disabled={!admin}>
        <legend className="mb-1.5 text-105 font-semibold text-ink-2">Look for</legend>
        {overview.limits.kinds.map((kind) => {
          const id = `detect-${kind}`;
          const info = KIND_LABEL[kind as DetectionKind];
          return (
            <label key={kind} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle">
              <Checkbox id={id} className="mt-px" disabled={!admin} checked={kinds.includes(kind as DetectionKind)} onChange={(on) => setKinds((current) => (overview.limits.kinds as DetectionKind[]).filter((item) => (item === kind ? on : current.includes(item))))} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-115 font-medium text-ink">{info.label}</span>
                <span className="text-105 leading-[14px] text-ink-3">{info.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <Field label="How often">
          {(id) => <Select id={id} className="w-[190px]" disabled={!admin} value={interval} onChange={setIntervalDays} options={overview.limits.interval_days.map((days) => ({ value: String(days), label: INTERVAL_LABEL[days] ?? `Every ${days} days` }))} />}
        </Field>
        <Field label="Monthly cap on Apollo credits" error={capError} hint="Runs stop for the month when this many credits have been used. Detection cannot be on without one.">
          {(id) => (
            <Input
              id={id} inputMode="numeric" frameClassName="w-[190px]" placeholder="No cap set" disabled={!admin} value={cap} invalid={Boolean(capError)}
              onFocus={(event) => event.target.select()} onChange={(event) => { setCap(event.target.value.replace(/[^\d]/g, "")); setCapError(null); }}
              trailing={<span className="shrink-0 pr-1 text-105 text-ink-3">credits</span>}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-subtle px-3 py-2.5" role="status" aria-label="What this would cost">
        <span className="text-10 font-semibold uppercase tracking-label text-ink-3">What this costs</span>
        {costLines(shown, Number(interval)).map((line) => <p key={line} className="text-115 leading-[17px] text-ink-2">{line}</p>)}
        <p className="text-105 leading-[15px] text-ink-3">Worked out from your settings and the accounts watched. Nothing has been asked of Apollo to show it.</p>
      </div>

      {admin ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line pt-3.5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <Switch
              checked={config.enabled} disabled={busy !== null || (!config.enabled && !overview.apollo_connected)} label="Scheduled detection"
              onChange={(on) => (on ? void turnOn() : void act("disable", () => put({ enabled: false }), "Detection is off. Nothing more is asked of Apollo."))}
            />
            <span className="text-12 font-medium text-ink">{config.enabled ? "On: runs by itself" : "Off: nothing is asked of Apollo"}</span>
          </label>
          <div className="flex items-center gap-2">
            {changed ? <Button loading={busy === "save"} disabled={busy !== null} onClick={() => { if (checkCap()) void act("save", () => put(settings()), "Settings saved"); }}>Save settings</Button> : null}
            <Button icon={Play} loading={busy === "run" || overview.running} disabled={busy !== null || overview.running || Boolean(overview.run_problem) || changed} title={changed ? "Save the settings first" : overview.run_problem ?? undefined} onClick={() => void runNow()}>
              {overview.running ? "Checking" : "Run now"}
            </Button>
          </div>
        </div>
      ) : null}
      {admin && overview.run_problem && !overview.running ? <p className="-mt-1.5 text-105 text-ink-3">Run now is not on offer: {overview.run_problem.charAt(0).toLowerCase() + overview.run_problem.slice(1)}</p> : null}
    </Card>
  );
}

interface ListOption { id: string; name: string }

/** Choose companies to watch: one at a time by name, or every company the contacts of a list work at. */
function AddAccountsDialog({ watched, onClose, onAdded }: { watched: Set<string>; onClose: () => void; onAdded: (overview: DetectionOverview, message: string) => void }) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [listId, setListId] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lists = useApi<ListOption[]>("/api/lists").data;
  const exclude = new Set([...watched, ...picked.map((item) => item.id)]);

  async function add() {
    if (picked.length === 0 && !listId) return setProblem("Choose a company, or a list to take the companies from.");
    setSaving(true);
    setProblem(null);
    try {
      const result = await api<{ added: number; left_out: number; overview: DetectionOverview }>(DETECTION_PATH, { method: "POST", body: { action: "watch", company_ids: picked.map((item) => item.id), ...(listId ? { list_id: listId } : {}) } });
      const message = result.added === 0 ? "Those accounts were already watched" : `${formatCount(result.added)} ${plural(result.added, "account", "accounts")} added`;
      onAdded(result.overview, result.left_out > 0 ? `${message}. ${formatCount(result.left_out)} did not fit: the list is full.` : message);
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
      title="Add accounts to watch"
      description="Each one adds to what a run costs"
      footer={
        <>
          <span className="text-105 text-ink-3">{picked.length > 0 ? `${picked.length} chosen` : ""}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void add()}>Add</Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem ? <Alert tone="bad">{problem}</Alert> : null}
        <Field label="Companies" hint="A company needs a website on its record to be looked up.">
          {() => (
            <div className="flex flex-col gap-1.5">
              {picked.map((item) => <RecordPicker key={item.id} kinds={["company"]} value={item} onChange={() => setPicked((current) => current.filter((other) => other.id !== item.id))} placeholder="" />)}
              <RecordPicker kinds={["company"]} value={null} exclude={exclude} onChange={(value) => { if (value) setPicked((current) => [...current, value]); }} placeholder="Search companies by name" />
            </div>
          )}
        </Field>
        <Field label="Or every company of a list" aside="Optional" hint="The companies its contacts work at. Contacts with no company are passed over.">
          {(id) => <Select id={id} className="w-full" value={listId || "__none"} onChange={(value) => setListId(value === "__none" ? "" : value)} options={[{ value: "__none", label: "No list" }, ...(lists ?? []).map((list) => ({ value: list.id, label: list.name }))]} />}
        </Field>
      </div>
    </Dialog>
  );
}
