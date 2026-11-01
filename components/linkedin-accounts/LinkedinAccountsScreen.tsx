import { useState } from "react";
import {useTranslations} from "next-intl";
import { CircleCheck, Plus, SlidersHorizontal, Send, Timer, Users } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Alert, Button, Card, EmptyState, ErrorState, KpiCard, LinkedinIcon, Pill, Skeleton, TextAction, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatPercent } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { AccountCard, type AccountAction } from "./AccountCard";
import { DeleteAccountDialog, TestActionDialog } from "./AccountDialogs";
import { ConnectPanel } from "./ConnectPanel";
import { EditAccountDrawer } from "./EditAccountDrawer";
import { PresetDialog } from "./PresetDialog";
import { OVERVIEW_PATH, attentionFor, presetLines, totals, type Attention, type LinkedinAccountView, type Overview } from "./model";

const DISMISSED_KEY = "linki.linkedin-accounts.dismissed";

function readDismissed(): string[] {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** Channels → LinkedIn accounts: every account, what it has done today, and connecting another. */
export function LinkedinAccountsScreen() {
  const t = useTranslations("LinkedinAccounts");
  const { data, error, isLoading, mutate } = useApi<Overview>(OVERVIEW_PATH);
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const [busy, setBusy] = useState<{ id: string; action: AccountAction } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  // Counts up so the connect panel starts clean after each finished sign-in.
  const [panelRound, setPanelRound] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>(() => (typeof window === "undefined" ? [] : readDismissed()));

  const accounts = data?.accounts ?? [];
  const byId = (id: string | null) => accounts.find((account) => account.id === id) ?? null;
  const refresh = () => void mutate();
  const notices = attentionFor(accounts).filter((notice) => !dismissed.includes(notice.key));
  const figures = totals(accounts);

  function dismiss(key: string) {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Private browsing: the notice just comes back on the next visit.
    }
  }

  function openConnect(accountId: string | null) {
    setReconnecting(accountId);
    setPanelRound((round) => round + 1);
    // The panel sits under the cards on a narrow window; bring it to the person.
    requestAnimationFrame(() => document.getElementById("connect-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  /** Run one request against an account, with the card showing it is busy. */
  async function run(action: AccountAction, account: LinkedinAccountView, work: () => Promise<string | void>) {
    setBusy({ id: account.id, action });
    try {
      const message = await work();
      if (message) toast.success(message);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function onAction(action: AccountAction, account: LinkedinAccountView) {
    const put = (body: Record<string, unknown>) => api(`/api/accounts/${account.id}`, { method: "PUT", body });
    switch (action) {
      case "edit":
        return setEditing(account.id);
      case "test":
        return setTesting(account.id);
      case "delete":
        return setDeleting(account.id);
      case "reconnect":
        return openConnect(account.id);
      case "pause": {
        const ok = await confirm({
          title: t("pauseTitle", {name: account.name}),
          body: t("pauseDescription"),
          confirmLabel: t("pauseConfirm"),
        });
        if (!ok) return;
        return run(action, account, async () => {
          await api(`/api/accounts/${account.id}/pause`, { method: "POST", body: { paused: true } });
          return t("paused", {name: account.name});
        });
      }
      case "resume":
        return run(action, account, async () => {
          await api(`/api/accounts/${account.id}/pause`, { method: "POST", body: { paused: false } });
          return t("resumed", {name: account.name});
        });
      case "check":
        return run(action, account, async () => {
          const result = await api<{ ok: boolean }>(`/api/accounts/${account.id}/test`, { method: "POST", body: { action: "session" } });
          if (!result.ok) throw new Error(t("signedOut", {name: account.name}));
          return t("signedIn", {name: account.name});
        });
      case "sync":
        return run(action, account, async () => {
          toast.message(t("reading", {name: account.name}), { description: t("readingHelp") });
          const sync = await api<{ connections_read: number; newly_accepted: number; unmarked_not_connected: number; verified_complete: boolean }>(`/api/accounts/${account.id}/sync-accepted`, { method: "POST" });
          const corrected = sync.unmarked_not_connected ? t("syncCorrected", {count: sync.unmarked_not_connected}) : "";
          const partial = sync.verified_complete ? "" : t("syncPartial");
          return t("syncSummary", {count: formatCount(sync.connections_read), accepted: sync.newly_accepted, corrected, partial});
        });
      case "stats":
        return run(action, account, async () => {
          await api(`/api/accounts/${account.id}/li-stats`, { method: "POST" });
          return t("statsUpdated", {name: account.name});
        });
      case "replies-on":
      case "replies-off":
        return run(action, account, async () => {
          await put({ sync_inbox: action === "replies-on" });
          return action === "replies-on" ? t("repliesOn", {name: account.name}) : t("repliesOff", {name: account.name});
        });
      case "cleanup-off":
        return run(action, account, async () => {
          await put({ withdraw_stale_invites: false });
          return t("cleanupOff", {name: account.name});
        });
      case "cleanup-on": {
        const { waiting, after_days, daily_limit } = account.invites.stale;
        const ok = await confirm({
          title: t("cleanupOnTitle", {name: account.name}),
          body: t("cleanupOnBody", {waiting, days: after_days, limit: daily_limit}),
          confirmLabel: t("cleanupOnConfirm"),
        });
        if (!ok) return;
        return run(action, account, async () => {
          await put({ withdraw_stale_invites: true });
          return t("cleanupOn", {name: account.name});
        });
      }
      case "disconnect": {
        const ok = await confirm({
          title: t("disconnectTitle", {name: account.name}),
          body: t("disconnectBody"),
          confirmLabel: t("disconnectConfirm"),
          tone: "danger",
        });
        if (!ok) return;
        return run(action, account, async () => {
          await api(`/api/accounts/${account.id}/disconnect`, { method: "POST" });
          return t("disconnected", {name: account.name});
        });
      }
    }
  }

  function onNotice(notice: Attention) {
    if (notice.action === "reconnect") openConnect(notice.accountId);
    else setEditing(notice.accountId);
  }

  const problemCount = accounts.filter((account) => account.status === "needs_signin").length;
  const holdCount = accounts.filter((account) => account.status === "weekly_hold").length;

  return (
    <Page
      title={t("title")}
      meta={
        <>
          {problemCount > 0 ? <Pill tone="bad" dot>{t("needsSignIn", {count: problemCount})}</Pill> : null}
          {holdCount > 0 ? <Pill tone="warn" icon={Timer}>{t("onHold", {count: holdCount})}</Pill> : null}
        </>
      }
      actions={
        <>
          <Button icon={SlidersHorizontal} onClick={() => setPresetOpen(true)} disabled={!data}>{t("limitPresets")}</Button>
          {can.admin ? <Button variant="primary" icon={Plus} onClick={() => openConnect(null)} disabled={!data}>{t("connectAccount")}</Button> : null}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={refresh} />
      ) : isLoading || !data ? (
        <LoadingLayout />
      ) : (
        <>
          {notices.map((notice) => {
            const account = byId(notice.accountId);
            return (
              <Alert
                key={notice.key} banner tone={notice.tone} title={notice.title} onDismiss={() => dismiss(notice.key)}
                actions={can.admin && account ? (
                  <Button className="h-[30px]" icon={notice.action === "reconnect" ? undefined : SlidersHorizontal} onClick={() => onNotice(notice)}>
                    {notice.action === "reconnect" ? t("signAgain") : notice.action === "proxy" ? t("checkProxy") : t("adjustLimits")}
                  </Button>
                ) : undefined}
              >
                {notice.detail}
              </Alert>
            );
          })}

          <div className="flex min-h-0 flex-1 flex-col gap-3.5 xl:flex-row xl:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                <KpiCard
                  label={t("connected")} icon={Users} value={formatCount(figures.connected)}
                  note={<span className={figures.healthyTone === "warn" ? "text-warn" : undefined}>{figures.healthyNote}</span>}
                />
                <KpiCard label={t("invites")} icon={Send} value={formatCount(figures.invitesToday)} note={<span className="text-ink-2">{t("dailyCap", {count: formatCount(figures.invitesCap)})}</span>} />
                <KpiCard label={t("acceptance")} icon={CircleCheck} value={data.acceptance.rate === null ? "—" : formatPercent(data.acceptance.rate)} note={<AcceptanceNote acceptance={data.acceptance} />} />
                <KpiCard
                  label={t("pending")} icon={Timer} value={figures.pending === null ? "—" : formatCount(figures.pending)}
                  note={figures.waitingWithdrawal > 0
                    ? <span className="text-warn">{t("pastWait", {count: formatCount(figures.waitingWithdrawal)})}</span>
                    : figures.pending === null ? t("refreshToCount") : t("nonePast")}
                />
              </div>

              {accounts.length === 0 ? (
                <Card>
                  <EmptyState icon={LinkedinIcon} title={t("noAccounts")}>
                    {t("noAccountsHelp")}
                  </EmptyState>
                </Card>
              ) : (
                accounts.map((account) => (
                  <AccountCard key={account.id} account={account} can={can} busy={busy?.id === account.id ? busy.action : null} onAction={onAction} />
                ))
              )}

              {can.admin && accounts.length > 0 ? (
                <button
                  type="button" onClick={() => openConnect(null)}
                  className="flex min-h-[46px] w-full flex-wrap items-center gap-x-[9px] gap-y-1 rounded-lg border border-line bg-subtle px-3.5 py-2 text-left transition-colors hover:border-line-strong"
                >
                  <Plus size={14} className="shrink-0 text-brand-strong" aria-hidden="true" />
                  <span className="text-12 font-semibold text-brand-strong">{t("connectAnother")}</span>
                  <span className="min-w-0 flex-1 text-11 text-ink-3">{t("newAccountPreset")}</span>
                </button>
              ) : null}
            </div>

            <div className={cn("flex w-full shrink-0 flex-col gap-3.5 xl:w-[364px]")}>
              {can.admin ? (
                <ConnectPanel
                  key={`${reconnecting ?? "new"}:${panelRound}`}
                  account={byId(reconnecting)} preset={data.preset} members={data.members}
                  onChanged={refresh}
                  onDone={() => { setReconnecting(null); setPanelRound((round) => round + 1); }}
                  onCancel={() => { setReconnecting(null); setPanelRound((round) => round + 1); }}
                />
              ) : (
                <Card className="flex flex-col gap-2.5 p-3.5">
                  <h2 className="text-125 font-semibold text-ink">{t("newAccountStarts")}</h2>
                  <ul className="flex flex-col gap-2 text-11 text-ink-2">
                    {presetLines(data.preset, "in its own time zone").map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  <p className="text-11 text-ink-3">{t("adminOnly")}</p>
                  <TextAction className="self-start" onClick={() => setPresetOpen(true)}>{t("seePreset")}</TextAction>
                </Card>
              )}
            </div>
          </div>

          <EditAccountDrawer account={byId(editing)} members={data.members} onClose={() => setEditing(null)} onSaved={refresh} />
          <TestActionDialog account={byId(testing)} onClose={() => setTesting(null)} onChanged={refresh} />
          <DeleteAccountDialog account={byId(deleting)} onClose={() => setDeleting(null)} onDeleted={refresh} />
          <PresetDialog open={presetOpen} preset={data.preset} accounts={accounts} canEdit={can.admin} onClose={() => setPresetOpen(false)} onSaved={refresh} />
        </>
      )}
    </Page>
  );
}

function AcceptanceNote({ acceptance }: { acceptance: Overview["acceptance"] }) {
  const t = useTranslations("LinkedinAccounts");
  if (acceptance.rate === null) return <>{t("acceptanceNone")}</>;
  if (acceptance.previous === null) return <>{t("acceptanceSent", {count: formatCount(acceptance.sent)})}</>;
  const points = (acceptance.rate - acceptance.previous) * 100;
  if (Math.abs(points) < 0.05) return <>{t("acceptanceSame")}</>;
  return <span className={points > 0 ? "text-good" : "text-bad"}>{points > 0 ? "+" : "−"}{t("acceptanceCompare", {delta: Math.abs(points).toFixed(1)})}</span>;
}

function LoadingLayout() {
  const t = useTranslations("LinkedinAccounts");
  return (
    <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label={t("loading")}>
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[102px] rounded-lg" />)}
        </div>
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-[158px] rounded-lg" />)}
      </div>
      <Skeleton className="h-[480px] w-full rounded-lg xl:w-[364px]" />
    </div>
  );
}
