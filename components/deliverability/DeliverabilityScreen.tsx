import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import {useTranslations} from "next-intl";
import { Ban, CalendarDays, Download, Inbox, Mail, MailX, Send, ShieldCheck } from "lucide-react";
import { Page } from "@/components/shell";
import { Button, Card, EmptyState, ErrorState, KpiCard, Pill, Select, Skeleton, Tooltip, type Icon } from "@/components/ui";
import { apiUrl, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { DnsCard } from "./DnsCard";
import { DoNotContactCard } from "./DoNotContact";
import { GuardLogCard } from "./GuardLog";
import { MailboxHealthCard } from "./MailboxHealthCard";
import { PlacementDialog } from "./PlacementDialog";
import { WarmupCard } from "./WarmupCard";
import { OVERVIEW_PATH, RANGE_OPTIONS, checkedLine, figures, scorePill, type DeliverabilityOverview, type Figure } from "./model";

const NOTE_TONE = { good: "text-good", warn: "text-warn", bad: "text-bad", muted: "text-ink-2" } as const;
const FIGURE_ICON: Record<Figure["key"], Icon> = { sent: Send, bounce: MailX, complaints: Ban, placement: Inbox };

/** Channels → Deliverability: one sending domain at a time, and what protects the workspace's mail as a whole. */
export function DeliverabilityScreen() {
  const t = useTranslations("Deliverability");
  const router = useRouter();
  const wantedDomain = typeof router.query.domain === "string" ? router.query.domain : undefined;
  const range = typeof router.query.range === "string" && RANGE_OPTIONS.some((option) => option.value === router.query.range) ? (router.query.range as "7" | "30" | "90") : "30";
  const { data, error, isLoading, mutate } = useApi<DeliverabilityOverview>(router.isReady ? OVERVIEW_PATH : null, { domain: wantedDomain, range });
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  // Open, and the mailbox the test should start from when a row asked for it.
  const [placement, setPlacement] = useState<{ from: string | null } | null>(null);
  const refresh = useCallback(() => { void mutate(); }, [mutate]);

  const domain = data?.domain ?? null;
  const pill = scorePill(domain?.dns.score?.score ?? null);
  const go = (query: Record<string, string>) => void router.replace({ pathname: "/deliverability", query: { ...(domain ? { domain: domain.domain } : {}), range, ...query } }, undefined, { shallow: true });

  return (
    <Page
      title={t("title")}
      meta={pill ? <Pill tone={pill.tone} icon={ShieldCheck}>{t("score", {score: domain?.dns.score?.score ?? 0})}</Pill> : null}
      actions={
        <>
          {domain ? (
            <Button asChild className="gap-1.5">
              <a href={apiUrl("/api/deliverability/report", { range })} download><Download size={14} className="text-ink-2" aria-hidden="true" />{t("exportReport")}</a>
            </Button>
          ) : null}
          {domain ? <Button variant="primary" icon={Inbox} onClick={() => setPlacement({ from: null })}>{can.admin ? t("runTest") : t("tests")}</Button> : null}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={refresh} />
      ) : isLoading || !data ? (
        <LoadingLayout />
      ) : !domain ? (
        <Card>
          <EmptyState icon={Mail} title={t("noDomain")} action={<Button asChild variant="primary"><Link href="/mailboxes">{t("goMailboxes")}</Link></Button>}>
            {t("noDomainHelp")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div role="tablist" aria-label={t("domain")} className="flex flex-wrap items-center gap-1.5">
              {data.domains.map((item) => {
                const active = item.domain === domain.domain;
                return (
                  <button
                    key={item.domain} type="button" role="tab" aria-selected={active} onClick={() => go({ domain: item.domain })}
                    className={cn("inline-flex h-8 items-center gap-[7px] rounded-md border px-[11px] text-12 font-medium transition-colors", active ? "border-line-strong bg-surface text-ink" : "border-transparent text-ink-2 hover:bg-control hover:text-ink")}
                  >
                    <span className={cn("size-1.5 rounded-full", item.score === null ? "bg-ink-3" : item.score >= 80 ? "bg-good" : item.score >= 60 ? "bg-warn" : "bg-bad")} aria-hidden="true" />
                    {item.domain}
                    <span className="sr-only">{item.score === null ? t("unchecked") : t("domainScore", {score: item.score})}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2.5">
              <Select label={t("period")} icon={CalendarDays} value={range} onChange={(value) => go({ range: value })} options={RANGE_OPTIONS.map(option => ({...option, label: t(option.value === "7" ? "last7" : option.value === "30" ? "last30" : "last90")}))} />
              <span className="text-11 text-ink-3">{domain.dns.checked_at ? t("checked", {date: checkedLine(domain.dns).replace(/^DNS last checked /, "")}) : t("notChecked")}</span>
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-3.5 lg:grid-cols-4">
            {figures(domain, data.range).map((figure) => (
              <KpiCard
                key={figure.key} label={t(`figure.${figure.key}`, {days: range})} icon={FIGURE_ICON[figure.key]} value={figure.value}
                note={figure.why ? (
                  <Tooltip label={figure.why}><span tabIndex={0} className={cn("cursor-help", NOTE_TONE[figure.tone])}>{figure.note}</span></Tooltip>
                ) : <span className={NOTE_TONE[figure.tone]}>{figure.note}</span>}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3.5 xl:flex-1 xl:flex-row xl:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <MailboxHealthCard domain={domain.domain} mailboxes={domain.mailboxes} settings={data.settings} canEdit={can.admin} onPlacementTest={(mailbox) => setPlacement({ from: mailbox.id })} />
              <GuardLogCard events={data.guard.events} total={data.guard.total} />
            </div>
            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[380px]">
              <DnsCard key={domain.domain} domain={domain.domain} dns={domain.dns} canEdit={can.admin} onChanged={refresh} />
              <WarmupCard domain={domain} canEdit={can.admin} onChanged={refresh} />
              <DoNotContactCard dnc={data.do_not_contact} can={can} onChanged={refresh} />
            </div>
          </div>

          <PlacementDialog
            key={placement?.from ?? "any"} open={placement !== null} from={placement?.from ?? null} domain={domain.domain} mailboxes={domain.mailboxes} seeds={data.seeds} runs={domain.placement_runs} canEdit={can.admin}
            onClose={() => setPlacement(null)} onChanged={refresh}
          />
        </>
      )}
    </Page>
  );
}

function LoadingLayout() {
  const t = useTranslations("Deliverability");
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label={t("loading")}>
      <Skeleton className="h-8 w-[360px] rounded-md" />
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[102px] rounded-lg" />)}
      </div>
      <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <Skeleton className="h-[380px] rounded-lg" />
          <Skeleton className="h-[220px] rounded-lg" />
        </div>
        <div className="flex w-full flex-col gap-3.5 xl:w-[380px]">
          <Skeleton className="h-[330px] rounded-lg" />
          <Skeleton className="h-[170px] rounded-lg" />
          <Skeleton className="h-[230px] rounded-lg" />
        </div>
      </div>
    </div>
  );
}
