import {useTranslations} from "next-intl";
import { ChartNoAxesColumn, CirclePause, CirclePlay, Clock, Cookie, EllipsisVertical, FlaskConical, Globe, Plug, RefreshCw, Server, Settings2, Trash2, Undo2, Unplug, UserCheck } from "lucide-react";
import { Avatar, Button, Card, Eyebrow, IconButton, Menu, MenuCheckItem, MenuItem, MenuSeparator, Meter, Pill, TextAction, TONE_TEXT, Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { DAYS, hourLabel, limitMeters, hostOf, methodBadge, parseDays, sessionBadge, statusBadge, syncLine, type LinkedinAccountView } from "./model";

export type AccountAction =
  | "pause" | "resume" | "reconnect" | "edit" | "check" | "test" | "sync" | "stats"
  | "replies-on" | "replies-off" | "cleanup-on" | "cleanup-off" | "disconnect" | "delete";

export interface AccountCardProps {
  account: LinkedinAccountView;
  /** What the signed-in member may do. */
  can: { member: boolean; manager: boolean; admin: boolean };
  /** The action running on this account right now, which shows a spinner and blocks the rest. */
  busy: AccountAction | null;
  onAction: (action: AccountAction, account: LinkedinAccountView) => void;
}

/** One LinkedIn account: who it is, where its session stands, today's use of each limit, and its schedule. */
export function AccountCard({ account, can, busy, onAction }: AccountCardProps) {
  const t = useTranslations("LinkedinAccountCard");
  const tWeek = useTranslations("LinkedinSettings");
  const weekdayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const accountMeta = [account.email, account.plan, account.owner ? t("ownedBy", {name: account.owner.name}) : null, account.proxy ? t("proxy", {value: account.proxy.label || hostOf(account.proxy.server)}) : null].filter(Boolean).join(" · ");
  const method = methodBadge(account);
  const session = sessionBadge(account);
  const status = statusBadge(account);
  const sync = syncLine(account);
  const signedIn = account.session.signed_in;
  const lost = account.status === "needs_signin";
  const days = new Set(parseDays(account.schedule.days));
  const act = (action: AccountAction) => () => onAction(action, account);
  const sessionLabel = account.session.signed_in ? account.session.error ? t("proxyUnavailable") : t("sessionHealthy") : account.status === "needs_signin" ? t("signinRequired") : account.status === "disconnected" ? t("disconnected") : t("notConnected");
  const statusLabel = account.status === "active" ? t("active") : account.status === "paused" ? t("paused") : account.status === "weekly_hold" ? t("weeklyHold") : account.status === "warming_up" ? account.ramp ? t("warmingDay", {day: account.ramp.day, total: account.ramp.days}) : t("warming") : status?.label;
  const methodLabel = account.session.method === "login" ? t("serverLogin") : account.session.method === "cookie" ? t("cookieSession") : method?.label;

  return (
    <Card className={cn("flex flex-col gap-3 p-3.5", !signedIn && "bg-surface")} aria-label={account.name} role="group">
      <div className="flex items-center gap-2.5">
        <Avatar name={account.name} size={34} tint={lost ? "bg-bad-tint" : "bg-li-tint"} className={lost ? "text-bad" : "text-li"} />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-13 font-semibold text-ink">{account.name}</h3>
            {method ? (
              <Pill tone={method.tone} icon={account.session.method === "login" ? Server : Cookie} className="h-[19px] text-10">
                {methodLabel}
              </Pill>
            ) : null}
            <Pill tone={session.tone} dot className="h-[19px] text-10">
              {sessionLabel}
            </Pill>
            {status ? (
              <Pill tone={status.tone} dot className="h-[19px] text-10">
                {statusLabel}
              </Pill>
            ) : null}
          </div>
          <p className="truncate text-105 text-ink-3" title={accountMeta}>
            {accountMeta}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cn("hidden whitespace-nowrap text-105 sm:inline", sync.bad ? "text-bad" : "text-ink-3")}>{sync.text}</span>
          {!signedIn ? (
            can.admin ? (
              <Button variant="primary" icon={Plug} className="h-7 px-[11px] text-115" onClick={act("reconnect")}>
                {account.status === "never_connected" ? t("connect") : t("reconnect")}
              </Button>
            ) : null
          ) : can.manager ? (
            account.paused ? (
              <IconButton icon={CirclePlay} label={t("resumeAria", {name: account.name})} size={28} variant="outline" disabled={busy !== null} onClick={act("resume")} />
            ) : (
              <IconButton icon={CirclePause} label={t("pauseAria", {name: account.name})} size={28} variant="outline" disabled={busy !== null} onClick={act("pause")} />
            )
          ) : null}
          {can.member ? (
            <Menu align="end" width={248} trigger={<IconButton icon={EllipsisVertical} label={t("moreAria", {name: account.name})} size={28} variant="outline" />}>
              {signedIn ? (
                <>
                  {can.admin ? (
                    <>
                      <MenuItem icon={UserCheck} disabled={busy !== null} onSelect={act("check")}>{t("checkSession")}</MenuItem>
                      <MenuItem icon={FlaskConical} disabled={busy !== null} onSelect={act("test")}>{t("testAction")}</MenuItem>
                    </>
                  ) : null}
                  <MenuItem icon={RefreshCw} disabled={busy !== null} onSelect={act("sync")}>{t("syncConnections")}</MenuItem>
                  <MenuItem icon={ChartNoAxesColumn} disabled={busy !== null} onSelect={act("stats")}>{t("refreshStats")}</MenuItem>
                  {can.admin ? <MenuSeparator /> : null}
                </>
              ) : null}
              {can.admin ? (
                <>
                  <MenuCheckItem checked={account.read_replies} onChange={(on) => onAction(on ? "replies-on" : "replies-off", account)}>
                    {t("readReplies")}
                  </MenuCheckItem>
                  <MenuCheckItem checked={account.invites.auto_withdraw} onChange={(on) => onAction(on ? "cleanup-on" : "cleanup-off", account)}>
                    {t("cleanupInvites")}
                  </MenuCheckItem>
                  <MenuSeparator />
                  <MenuItem icon={Settings2} onSelect={act("edit")}>{t("editSettings")}</MenuItem>
                  {signedIn ? <MenuItem icon={Plug} onSelect={act("reconnect")}>{t("signAgain")}</MenuItem> : null}
                  {signedIn ? <MenuItem icon={Unplug} onSelect={act("disconnect")}>{t("disconnect")}</MenuItem> : null}
                  <MenuItem icon={Trash2} tone="danger" onSelect={act("delete")}>{t("delete")}</MenuItem>
                </>
              ) : null}
            </Menu>
          ) : null}
        </div>
      </div>

      {account.paused?.reason ? <p className="text-11 text-ink-2">{t("pausedReason", {reason: account.paused.reason})}</p> : null}

      <div className={cn("grid grid-cols-2 gap-x-2.5 gap-y-3 lg:grid-cols-4", !signedIn && "opacity-60")}>
        {limitMeters(account).map((meter) => (
          <div key={meter.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Eyebrow className="truncate">{t(`meter.${meter.key}`)}</Eyebrow>
              <span className={cn("whitespace-nowrap text-115 font-semibold", meter.tone === "warn" ? TONE_TEXT.warn : "text-ink")}>
                {meter.used} / {meter.limit}
              </span>
            </div>
            <Meter value={meter.used} max={meter.limit} tone={meter.tone} label={t("today", {name: t(`meter.${meter.key}`)})} />
            <p className="truncate text-10 text-ink-3" title={meter.note}>{meter.note}</p>
          </div>
        ))}
      </div>

      <div className="h-px w-full bg-line" />

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-11 text-ink-2">
          <Clock size={13} className="text-ink-3" aria-hidden="true" />
          {hourLabel(account.schedule.start)}–{hourLabel(account.schedule.end)}
        </span>
        <span className="inline-flex items-center gap-[3px]" role="img" aria-label={t("worksDays", {days: DAYS.filter(day => days.has(day.value)).map(day => tWeek(`days.${weekdayKeys[day.value - 1]}`)).join(", ") || t("daysNone")})}>
          {DAYS.map((day) => (
            <span
              key={day.value}
              className={cn("inline-flex size-[17px] items-center justify-center rounded-[5px] text-95 font-semibold", days.has(day.value) ? "bg-brand-tint text-brand-strong" : "bg-control text-ink-3")}
              aria-hidden="true"
            >
              {t(`weekdayLetter.${weekdayKeys[day.value - 1]}`)}
            </span>
          ))}
        </span>
        <span className="inline-flex items-center gap-1.5 text-11 text-ink-2">
          <Globe size={13} className="text-ink-3" aria-hidden="true" />
          {account.schedule.timezone}
        </span>
        <Tooltip
          label={account.invites.auto_withdraw
            ? t("withdrawAuto", {count: account.invites.stale.waiting})
            : t("withdrawManual", {days: account.invites.wait_days, count: account.invites.stale.waiting})}
        >
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-11 text-ink-2">
            <Undo2 size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
            <span className="truncate">
              {t("withdrawAfter", {days: account.invites.wait_days})}{account.invites.auto_withdraw ? "" : ` · ${t("cleanupOff")}`}
            </span>
          </span>
        </Tooltip>
        {can.admin ? <TextAction onClick={act("edit")}>{t("editLimits")}</TextAction> : null}
      </div>
    </Card>
  );
}
