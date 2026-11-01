import { useEffect, useState } from "react";
import {useTranslations} from "next-intl";
import Link from "next/link";
import { Ellipsis, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Alert, Button, Card, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Pill, Skeleton, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatDate } from "@/lib/client/format";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import type { AiOverview } from "@/pages/api/ai/overview";
import { ConnectDialog } from "./ConnectDialog";
import { IntegrationGlyph } from "./IntegrationGlyph";
import {
  CONNECTIONS_PATH, KEYS_PATH, STATE, connectionLine, connectionSettings, connectionState, integrationStatuses, integrationSummary, syncResult,
  type ConnectionRow, type Integration, type IntegrationId, type IntegrationStatus, type ProviderKey,
} from "./model";

const GROUPS = ["Data and AI", "CRM", "Calendars"] as const;

/** Configure → Integrations: the outside services Linki works with, and the state of each. */
export function IntegrationsScreen() {
  const t = useTranslations("Integrations");
  const keys = useApi<ProviderKey[]>(KEYS_PATH);
  const connections = useApi<ConnectionRow[]>(CONNECTIONS_PATH);
  const ai = useApi<AiOverview>("/api/ai/overview");
  const admin = useCan("admin");
  const [dialog, setDialog] = useState<{ integration: Integration; connection: ConnectionRow | null; replacingKey?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = Boolean(keys.data && connections.data);

  // A link from another page names a card ("/integrations#hubspot"). The cards arrive after
  // the page does, so the browser's own jump to it has already missed.
  useEffect(() => {
    if (!ready || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [ready]);

  const refresh = () => {
    void keys.mutate();
    void connections.mutate();
  };

  async function run(key: string, work: () => Promise<void>, failed?: string) {
    // One thing at a time. The menus stay usable meanwhile (a disabled button would drop the keyboard's focus), so this is where a second action stops.
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (cause) {
      // What a provider says when it refuses is rarely a sentence: say what was being done as well.
      if (failed) toast.error(failed, { description: errorMessage(cause), duration: 10_000 });
      else toast.error(errorMessage(cause), { duration: 10_000 });
    } finally {
      refresh();
      setBusy(null);
    }
  }

  const sync = (connection: ConnectionRow) =>
    run(connection.id, async () => {
      const result = await api<Record<string, unknown>>(CONNECTIONS_PATH, { method: "PUT", body: { id: connection.id } });
      toast.success(t("synced", {name: connection.name}), { description: syncResult(result) });
    }, t("syncFailure", {name: connection.name}));

  const setEnabled = (connection: ConnectionRow, enabled: boolean) =>
    run(connection.id, async () => {
      await api(CONNECTIONS_PATH, { method: "PATCH", body: { id: connection.id, enabled } });
      toast.success(enabled ? t("syncsAgain", {name: connection.name}) : t("isPaused", {name: connection.name}));
    });

  async function disconnect(connection: ConnectionRow) {
    const ok = await confirm({
      title: t("disconnectTitle", {name: connection.name}),
      body: t("disconnectBody"),
      confirmLabel: t("disconnect"),
      tone: "danger",
    });
    if (!ok) return;
    await run(connection.id, async () => {
      await api(CONNECTIONS_PATH, { method: "DELETE", query: { id: connection.id } });
      toast.success(t("wasDisconnected", {name: connection.name}));
    });
  }

  async function removeKey(integration: Integration) {
    const ok = await confirm({
      title: t("removeKeyTitle", {name: integration.name}),
      body: integration.id === "openrouter"
        ? "AI writing and reply classification stop until a key is saved again. Steps that need AI wait; nothing is sent in its place."
        : "Enriching a list with Apollo stops working until a key is saved again.",
      confirmLabel: t("removeKey"),
      tone: "danger",
    });
    if (!ok) return;
    await run(integration.id, async () => {
      await api(KEYS_PATH, { method: "DELETE", query: { key: integration.id } });
      toast.success(t("keyRemoved", {name: integration.name}));
    });
  }

  const error = keys.error ?? connections.error;
  const extra: Partial<Record<IntegrationId, string>> = ai.data?.provider.connected ? { openrouter: `$${ai.data.usage.month.spent_usd.toFixed(2)} spent this month` } : {};
  const statuses = keys.data && connections.data ? integrationStatuses(keys.data, connections.data, new Date(), extra) : null;

  return (
    <Page title={t("title")} meta={statuses ? <span className="text-11 text-ink-3">{integrationSummary(statuses)}</span> : null}>
      {error && !statuses ? (
        <Card><ErrorState message={errorMessage(error)} onRetry={refresh} /></Card>
      ) : !statuses ? (
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2" aria-busy="true" aria-label={t("loading")}>
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-[150px] rounded-lg" />)}
        </div>
      ) : (
        <>
          {!admin ? <Alert tone="neutral">{t("readOnly")}</Alert> : null}
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`group-${group}`} className="flex flex-col gap-2.5">
              <h2 id={`group-${group}`} className="text-10 font-semibold uppercase tracking-label text-ink-3">{group === "Data and AI" ? t("groups.data") : group === "Calendars" ? t("groups.calendar") : t("groups.crm")}</h2>
              <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
                {statuses.filter((status) => status.integration.group === group).map((status) => (
                  <IntegrationCard
                    key={status.integration.id} status={status} admin={admin} busy={busy}
                    onConnect={() => setDialog({ integration: status.integration, connection: null, replacingKey: Boolean(status.key) })}
                    onEdit={(connection) => setDialog({ integration: status.integration, connection })}
                    onSync={(connection) => void sync(connection)}
                    onEnabled={(connection, enabled) => void setEnabled(connection, enabled)}
                    onDisconnect={(connection) => void disconnect(connection)}
                    onRemoveKey={() => void removeKey(status.integration)}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      {dialog ? (
        <ConnectDialog
          key={`${dialog.integration.id}:${dialog.connection?.id ?? "new"}`}
          integration={dialog.integration} connection={dialog.connection} replacingKey={dialog.replacingKey}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            toast.success(message);
            refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

function IntegrationCard({ status, admin, busy, onConnect, onEdit, onSync, onEnabled, onDisconnect, onRemoveKey }: {
  status: IntegrationStatus;
  admin: boolean;
  busy: string | null;
  onConnect: () => void;
  onEdit: (connection: ConnectionRow) => void;
  onSync: (connection: ConnectionRow) => void;
  onEnabled: (connection: ConnectionRow, enabled: boolean) => void;
  onDisconnect: (connection: ConnectionRow) => void;
  onRemoveKey: () => void;
}) {
  const t = useTranslations("Integrations");
  const { integration, connected, key, connections, failing } = status;
  return (
    <Card id={integration.id} className="flex scroll-mt-4 flex-col gap-3 p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-2"><IntegrationGlyph icon={integration.icon} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-13 font-semibold text-ink">{integration.name}</h3>
            {connected ? <Pill size="sm" tone={failing ? "bad" : "good"}>{failing ? t("syncFail") : t("connected")}</Pill> : null}
          </div>
          <p className="text-11 text-ink-3">{integration.purpose}</p>
        </div>
        {admin && integration.kind === "connection" ? (
          <Button size="sm" variant={connected ? "secondary" : "primary"} icon={connected ? Plus : undefined} onClick={onConnect}>{connected ? t("addAnother") : t("connect")}</Button>
        ) : admin && !connected ? (
          <Button size="sm" variant="primary" onClick={onConnect}>{t("connect")}</Button>
        ) : null}
      </div>

      <p className="text-115 leading-[17px] text-ink-2">{integration.about}</p>

      {key ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md bg-subtle px-2.5 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-11 text-ink">{key.api_key_masked}</span>
            <span className="text-105 text-ink-3">
              {t("saved", {date: formatDate(key.updated_at)})}
              {integration.id === "openrouter" ? <> · <Link href="/ai" className="font-semibold text-brand-strong hover:underline">{t("models")}</Link></> : ` · ${t("usedForEnrichment")}`}
            </span>
          </div>
          {admin ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="xs" disabled={busy === integration.id} onClick={onConnect}>{t("replaceKey")}</Button>
              <Button size="xs" variant="danger" loading={busy === integration.id} onClick={onRemoveKey}>{t("remove")}</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {connections.length > 0 ? (
        <ul className="flex flex-col">
          {connections.map((connection) => {
            const state = connectionState(connection);
            const working = busy === connection.id;
            const settings = Object.values(connectionSettings(connection)).filter(Boolean);
            return (
              <li key={connection.id} aria-busy={working || undefined} className={cn("flex flex-col gap-2 border-t border-line py-2.5 last:pb-0", working && "opacity-70")}>
                <div className="flex items-center gap-2.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-12 font-medium text-ink">{connection.name}</span>
                      {/* With one connection the card's own pill says it is connected or failing; the row adds only what that leaves out. */}
                      {connections.length > 1 || state === "paused" || state === "waiting" ? <Pill size="sm" tone={STATE[state].tone}>{state === "connected" ? t("connected") : state === "failing" ? t("syncFail") : state === "paused" ? t("paused") : t("waiting")}</Pill> : null}
                    </div>
                    <span className="truncate text-105 text-ink-3" title={settings.join(" · ") || undefined}>
                      {connectionLine(connection)}
                      {settings.length > 0 ? ` · ${settings[0]}` : ""}
                    </span>
                  </div>
                  {admin ? (
                    <>
                      <Button size="xs" icon={RefreshCw} loading={working} disabled={busy !== null || !connection.enabled} title={connection.enabled ? integration.sync ?? undefined : t("resumeToSync")} onClick={() => onSync(connection)}>{t("syncNow")}</Button>
                      <Menu trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name: connection.name})} size={24} />}>
                        <MenuItem icon={Pencil} onSelect={() => onEdit(connection)}>{t("changeSettings")}</MenuItem>
                        {connection.enabled
                          ? <MenuItem icon={Pause} onSelect={() => onEnabled(connection, false)}>{t("pauseSync")}</MenuItem>
                          : <MenuItem icon={Play} onSelect={() => onEnabled(connection, true)}>{t("resumeSync")}</MenuItem>}
                        <MenuSeparator />
                        <MenuItem icon={Trash2} tone="danger" onSelect={() => onDisconnect(connection)}>{t("disconnect")}</MenuItem>
                      </Menu>
                    </>
                  ) : null}
                </div>
                {connection.sync_error ? <Alert tone="bad" title={t("syncFailed")}><span className="break-words">{connection.sync_error}</span></Alert> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
