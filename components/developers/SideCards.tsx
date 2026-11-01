import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { PlugZap } from "lucide-react";
import { Card, CodeBlock, ErrorState, Eyebrow, Pill, Segmented, Skeleton, TextAction, Tooltip } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import { useApi } from "@/lib/client/data";
import { IntegrationGlyph } from "@/components/integrations/IntegrationGlyph";
import { CONNECTIONS_PATH, KEYS_PATH as PROVIDER_KEYS_PATH, integrationStatuses, integrationSummary, type ConnectionRow, type IntegrationId, type ProviderKey } from "@/components/integrations/model";
import type { AiOverview } from "@/pages/api/ai/overview";
import { INSTANCE_PATH, MCP_PATH, SERVICE_TONE, foldedLoops, healthPill, mcpSnippets, serviceRows, shownGroups, type InstanceHealth, type McpInfo } from "./model";

/** Where an MCP client connects, how, and what it will find there. */
export function McpCard() {
  const t = useTranslations("DeveloperSideCards");
  const locale = useLocale();
  const { data, error, isLoading, mutate } = useApi<McpInfo>(MCP_PATH);
  const [format, setFormat] = useState<"cli" | "opencode" | "json" | "key">("cli");
  const [allGroups, setAllGroups] = useState(false);

  if (error && !data) return <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>;
  if (isLoading || !data) return <Skeleton className="h-[292px] rounded-lg" />;

  const snippets = mcpSnippets(data.url);
  const groups = allGroups ? { shown: data.groups, more: 0 } : shownGroups(data.groups);
  return (
    <Card className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand"><PlugZap size={15} aria-hidden="true" /></span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("mcpTitle")}</h2>
            <p className="truncate text-11 text-ink-3">{t("mcpTools", {count: data.tools})}</p>
          </div>
        </div>
        <Pill tone="good" dot>{t("live")}</Pill>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <span className="whitespace-nowrap text-105 text-ink-2">{t("addClient")}</span>
          <Segmented
            size="sm" label={t("howAdd")} value={format} onChange={setFormat}
            options={[{ value: "cli", label: "Claude" }, { value: "opencode", label: "opencode" }, { value: "json", label: ".mcp.json" }, { value: "key", label: "API key" }]}
          />
        </div>
        {format === "key" ? (
          <>
            <CodeBlock code={snippets.key} caption={t("terminal")} />
            <CodeBlock code={snippets.opencodeKey} caption="opencode.json" />
            <p className="text-105 leading-[15px] text-ink-3">
              {t("keyHint")}
            </p>
          </>
        ) : (
          <>
            <CodeBlock
              code={format === "cli" ? snippets.cli : format === "opencode" ? snippets.opencode : snippets.json}
              caption={format === "cli" ? "Run in a terminal, then /mcp to sign in" : format === "opencode" ? "opencode.json, then opencode mcp auth linki" : ".mcp.json in a project, or the Claude Code config"}
            />
            <p className="text-105 leading-[15px] text-ink-3">
              {t("authHint")}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-[7px]">
        <Eyebrow>{t("groups")}</Eyebrow>
        <div className="flex flex-wrap gap-[5px]">
          {groups.shown.map((group) => (
            <span key={group.key} className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-subtle px-2">
              <span className="text-105 font-semibold text-ink-2">{group.label}</span>
              <span className="text-95 text-ink-3">{group.tools}</span>
            </span>
          ))}
          {groups.more > 0 ? (
            <button type="button" onClick={() => setAllGroups(true)} className="inline-flex h-[22px] items-center rounded-full bg-subtle px-2 text-105 font-semibold text-ink-3 hover:bg-control hover:text-ink-2">
              {t("moreGroups", {count: groups.more})}
            </button>
          ) : null}
        </div>
        <p className="text-105 text-ink-3">
          {t("readOnly", {count: data.read_only_tools})}
          {data.calls_30d > 0 ? t("calls", {count: data.calls_30d, relative: formatRelativeByLocale(data.last_call_at, locale)}) : " " + t("notUsed")}
        </p>
      </div>
    </Card>
  );
}

/** Which integrations are connected, with a way to the page that manages them. */
export function IntegrationsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("DeveloperSideCards");
  const locale = useLocale();
  const keys = useApi<ProviderKey[]>(PROVIDER_KEYS_PATH);
  const connections = useApi<ConnectionRow[]>(CONNECTIONS_PATH);
  // This month's AI spend, for the line under OpenRouter. The card does without it if it does not load.
  const ai = useApi<AiOverview>("/api/ai/overview");

  const error = keys.error ?? connections.error;
  if (error && (!keys.data || !connections.data)) {
    return <Card><ErrorState message={errorMessage(error)} onRetry={() => { void keys.mutate(); void connections.mutate(); }} /></Card>;
  }
  if (!keys.data || !connections.data) return <Skeleton className="h-[300px] rounded-lg" />;

  const extra: Partial<Record<IntegrationId, string>> = ai.data?.provider.connected ? { openrouter: t("spent", {amount: ai.data.usage.month.spent_usd.toFixed(2)}) } : {};
  const statuses = integrationStatuses(keys.data, connections.data, new Date(), extra);
  // Connected ones first, then the rest in their usual order; the card has room for five.
  const shown = [...statuses.filter((status) => status.connected), ...statuses.filter((status) => !status.connected)].slice(0, 5);
  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("integrations")}</h2>
          <p className="truncate text-11 text-ink-3">{locale === "pt-BR" ? t("connectedCount", {count: statuses.filter((status) => status.connected).length, total: statuses.length}) : integrationSummary(statuses)}</p>
        </div>
        <Link href="/integrations" className="shrink-0 pt-0.5 text-11 font-semibold text-brand-strong hover:underline">{t("browse")}</Link>
      </div>
      <ul className="flex flex-col">
        {shown.map(({ integration, connected, failing, line }) => (
          <li key={integration.id} className="flex items-center gap-2.5 border-t border-line py-2 first:border-t-0 first:pt-0 last:pb-0">
            <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-2"><IntegrationGlyph icon={integration.icon} size={15} /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-12 font-medium text-ink">{integration.name}</span>
                {connected ? <Pill size="sm" tone={failing ? "bad" : "good"}>{failing ? t("syncFail") : t("connected")}</Pill> : null}
              </div>
              <span className="truncate text-105 text-ink-3" title={line}>{line}</span>
            </div>
            {connected || admin ? (
              <Link
                href={`/integrations#${integration.id}`}
                className={cn(
                  "inline-flex h-[26px] shrink-0 items-center rounded-md px-2.5 text-11 font-semibold transition-colors",
                  connected ? "border border-line-strong bg-surface text-ink hover:bg-subtle" : "bg-brand text-white hover:bg-brand-strong",
                )}
              >
                {connected ? (admin ? t("manage") : t("view")) : t("connect")}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** How the instance is doing. For admins: the route behind it refuses everyone else. */
export function HealthCard() {
  const t = useTranslations("DeveloperSideCards");
  const { data, error, isLoading, mutate } = useApi<InstanceHealth>(INSTANCE_PATH, undefined, { refreshInterval: 60_000 });
  const [all, setAll] = useState(false);

  if (error && !data) return <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>;
  if (isLoading || !data) return <Skeleton className="h-[270px] rounded-lg" />;

  const pill = healthPill(data);
  const rows = serviceRows(data, all);
  const folded = foldedLoops(data);
  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("health")}</h2>
          <p className="truncate text-11 text-ink-3">{t("selfHosted")}</p>
        </div>
        <Tooltip label={t("uptime", {hours: Math.floor(data.uptime_seconds / 3600), minutes: Math.floor((data.uptime_seconds % 3600) / 60)})}>
          <span tabIndex={0} className="inline-flex shrink-0 rounded-full"><Pill tone={pill.tone} dot>{data.status === "off" ? t("backgroundOff") : pill.label}</Pill></span>
        </Tooltip>
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2.5 border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0">
            <span className={cn("size-[7px] shrink-0 rounded-full", SERVICE_TONE[row.status].dot)} aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-12 font-medium text-ink">{row.key === "app" ? t("serviceApp") : row.key === "runners" ? t("serviceRunner") : row.key === "database" ? t("serviceDatabase") : row.key === "others" ? t("serviceOther", {count: folded}) : row.name}</span>
              <span className="truncate text-105 text-ink-3" title={row.meta}>{row.meta}</span>
            </div>
            <span className={cn("shrink-0 text-105 font-semibold", SERVICE_TONE[row.status].text)}>{t(row.status === "healthy" ? "healthy" : row.status === "degraded" ? "degraded" : row.status === "off" ? "off" : "idle")}</span>
          </li>
        ))}
      </ul>
      {folded > 0 || all ? (
        <TextAction className="self-start" onClick={() => setAll((value) => !value)}>{all ? t("showFewer") : t("showAll", {count: data.loops.length})}</TextAction>
      ) : null}
    </Card>
  );
}
