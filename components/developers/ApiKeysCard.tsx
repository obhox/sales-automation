import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Ban, Ellipsis, KeyRound, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, EmptyState, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Pill, Tooltip, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import { parseTime } from "@/lib/client/format";
import { EditKeyDialog } from "./KeyDialogs";
import { Chip, CopyIcon, RowSkeleton } from "./parts";
import { KEYS_PATH, expiryCell, isExpired, isRevoked, lastUsed, maskedKey, rateLimitLabel, rateLimitSummary, scopeChips, scopeList, type ApiKeyRow } from "./model";

const GRID = "grid grid-cols-[minmax(170px,1fr)_210px_120px_104px_28px] items-center gap-3 px-3.5";
const EXPIRY_TONE = { neutral: "text-ink-2", warn: "text-warn", bad: "text-bad" };

/** The workspace's API keys: what each may do, when it stops working and when it was last used. */
export function ApiKeysCard({ keys, loading, error, admin, onRetry, onChanged, onCreate }: {
  keys: ApiKeyRow[] | undefined;
  loading: boolean;
  error: unknown;
  admin: boolean;
  onRetry: () => void;
  onChanged: () => void;
  onCreate: () => void;
}) {
  const t = useTranslations("DeveloperApiKeys");
  const locale = useLocale();
  const [editing, setEditing] = useState<ApiKeyRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const summary = keys ? rateLimitSummary(keys) : null;
  const summaryLabel = locale === "pt-BR" && keys ? (() => {
    const active = keys.filter((key) => !isRevoked(key) && !isExpired(key));
    const limited = active.filter((key) => key.rate_limit_per_minute != null);
    return active.length && new Set(active.map((key) => key.rate_limit_per_minute)).size > 1
      ? t("rateLimited", {count: limited.length, total: active.length}) : summary;
  })() : summary;
  const localExpiry = (key: ApiKeyRow, expiry: ReturnType<typeof expiryCell>) => {
    if (locale !== "pt-BR") return expiry;
    const revoked = parseTime(key.revoked_at), expires = parseTime(key.expires_at);
    const date = revoked ?? expires;
    const dateLabel = date ? date.toLocaleDateString("pt-BR", {day: "numeric", month: "short", year: "numeric"}) : "";
    const days = expires ? Math.ceil((expires.getTime() - Date.now()) / 86_400_000) : null;
    if (revoked) return {...expiry, date: t("revokedAt", {date: dateLabel}), note: t("revoked")};
    if (!expires) return {...expiry, date: t("never"), note: t("noExpiry")};
    if (days !== null && days <= 0) return {...expiry, date: dateLabel, note: t("expired")};
    return {...expiry, date: dateLabel, note: t("inDays", {count: days ?? 0})};
  };

  async function revoke(key: ApiKeyRow) {
    const ok = await confirm({
      title: t("revokeTitle", {name: key.name}),
      body: t("revokeBody"),
      confirmLabel: t("revokeKey"),
      tone: "danger",
    });
    if (!ok || busy) return;
    setBusy(key.id);
    try {
      await api(KEYS_PATH, { method: "DELETE", query: { id: key.id } });
      toast.success(t("revokedMessage", {name: key.name}));
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("title")}</h2>
          <p className="truncate text-11 text-ink-3">{t("subtitle")}</p>
        </div>
        {summary ? <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-subtle px-2 text-105 font-semibold text-ink-2">{summaryLabel}</span> : null}
      </div>

      {error && !keys ? (
        <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={onRetry} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label={t("title")} className="min-w-[708px]">
            <div role="row" className={cn(GRID, "h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
              <span role="columnheader">{t("name")}</span>
              <span role="columnheader">{t("scopes")}</span>
              <span role="columnheader">{t("expires")}</span>
              <span role="columnheader">{t("lastUsed")}</span>
              <span role="columnheader"><span className="sr-only">{t("actions")}</span></span>
            </div>
            {loading || !keys ? <RowSkeleton label={t("loading")} /> : keys.map((key) => {
              const revoked = isRevoked(key);
              const expired = !revoked && isExpired(key);
              const chips = scopeChips(key.scopes);
              const expiry = localExpiry(key, expiryCell(key));
              return (
                <div key={key.id} role="row" aria-busy={busy === key.id || undefined} className={cn(GRID, "h-14 border-t border-line", busy === key.id && "opacity-60")}>
                  <div role="cell" className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("truncate text-12 font-medium", revoked || expired ? "text-ink-2" : "text-ink")}>{key.name}</span>
                      {revoked ? <Pill tone="bad" size="sm">{t("revoked")}</Pill> : expired ? <Pill tone="bad" size="sm">{t("expired")}</Pill> : null}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-105 text-ink-3">{maskedKey(key.key_prefix)}</span>
                      <CopyIcon text={key.key_prefix} label={t("copyPrefix")} />
                      {key.rate_limit_per_minute && !revoked ? <span className="shrink-0 text-105 text-ink-3">· {rateLimitLabel(key.rate_limit_per_minute)}</span> : null}
                    </div>
                  </div>
                  <div role="cell" className="flex min-w-0 items-center gap-1">
                    {chips.shown.map((scope) => <Chip key={scope} mono>{scope}</Chip>)}
                    {chips.more > 0 ? (
                      <Tooltip label={scopeList(key.scopes).slice(chips.shown.length).join(", ")}>
                        <span tabIndex={0} className="shrink-0 rounded-sm text-10 font-bold text-ink-3">+{chips.more}</span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("truncate text-115 font-medium", expiry.tone === "bad" ? "text-bad" : "text-ink")}>{expiry.date}</span>
                    <span className={cn("truncate text-105", EXPIRY_TONE[expiry.tone])}>{expiry.note}</span>
                  </div>
                  <span role="cell" className="truncate text-11 text-ink-3">{locale === "pt-BR" ? key.last_used_at ? formatRelativeByLocale(key.last_used_at, locale) : t("neverUsed") : lastUsed(key.last_used_at)}</span>
                  <div role="cell" className="flex justify-end">
                    {admin && !revoked ? (
                      <Menu trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name: key.name})} size={28} />}>
                        <MenuItem icon={Pencil} onSelect={() => setEditing(key)}>{t("renameLimit")}</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Ban} tone="danger" onSelect={() => void revoke(key)}>{t("revokeKey")}</MenuItem>
                      </Menu>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {keys && keys.length === 0 ? (
        <EmptyState
          icon={KeyRound} title={t("noKeys")} className="border-t border-line"
          action={admin ? <Button variant="primary" icon={Plus} onClick={onCreate}>{t("createKey")}</Button> : undefined}
        >
          {admin ? t("adminHint") : t("readOnlyHint")}
        </EmptyState>
      ) : null}
      {editing ? <EditKeyDialog key={editing.id} apiKey={editing} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
    </Card>
  );
}
