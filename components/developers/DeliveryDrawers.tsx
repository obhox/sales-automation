import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Inbox, RotateCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Button, Drawer, EmptyState, ErrorState, LoadingState, Pill } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTimeByLocale } from "@/lib/client/localize-relative";
import { useApi } from "@/lib/client/data";
import { DELIVERY_STATUS, WEBHOOKS_PATH, deliveryDetail, hookName, type DeadLetter, type Delivery, type WebhookRow } from "./model";

// A log belongs to one endpoint: another's rows must not show while this one's load.
const FRESH = { keepPreviousData: false, revalidateOnMount: true };

interface Redelivered {
  status: string;
  response_status: number | null;
  last_error: string | null;
}

function useRedeliver(after: () => void) {
  const t = useTranslations("DeveloperDeliveries");
  const [busy, setBusy] = useState<string | null>(null);
  async function redeliver(id: string) {
    setBusy(id);
    try {
      const result = await api<Redelivered>(WEBHOOKS_PATH, { method: "PUT", body: { delivery_id: id } });
      if (result.status === "delivered") toast.success(t("accepted"), { description: t("answered", {code: result.response_status ?? 200}) });
      else if (result.status === "pending") toast.message(t("pending"), { description: t("pendingHint") });
      else toast.error(t("rejected"), { description: result.last_error ?? t("noResponse"), duration: 10_000 });
      after();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }
  return { busy, redeliver };
}

/** The last fifty deliveries to one endpoint: what was sent and how it answered. */
export function DeliveriesDrawer({ hook, admin, onClose, onChanged }: { hook: WebhookRow | null; admin: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("DeveloperDeliveries");
  const locale = useLocale();
  const { data, error, isLoading, mutate } = useApi<Delivery[]>(hook ? WEBHOOKS_PATH : null, hook ? { deliveries: hook.id } : undefined, FRESH);
  const { busy, redeliver } = useRedeliver(() => {
    void mutate();
    onChanged();
  });

  return (
    <Drawer open={Boolean(hook)} onOpenChange={(next) => (next ? undefined : onClose())} icon={ScrollText} title={t("log")} description={hook ? hookName(hook) : undefined} width={480}>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <LoadingState label={t("loading")} />
      ) : data.length === 0 ? (
        <EmptyState icon={ScrollText} title={t("empty")}>{t("emptyHint")}</EmptyState>
      ) : (
        <div className="flex flex-col">
          <p className="pb-2 text-105 text-ink-3">{t("latest", {count: data.length})}</p>
          <ul className="flex flex-col">
            {data.map((delivery) => {
              const status = DELIVERY_STATUS[delivery.status] ?? { label: delivery.status, tone: "neutral" as const };
              return (
                <li key={delivery.id} className="flex items-start justify-between gap-3 border-t border-line py-2.5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-115 font-medium text-ink">{delivery.event_type}</span>
                      <Pill tone={status.tone} size="sm">{t(delivery.status === "pending" ? "queued" : delivery.status === "delivered" ? "delivered" : delivery.status === "dead" ? "dead" : "failed")}</Pill>
                    </div>
                    <span className="break-words text-105 leading-[15px] text-ink-2">{deliveryDetail(delivery)}</span>
                    <span className="text-105 text-ink-3">{formatDateTimeByLocale(delivery.created_at, locale)}</span>
                  </div>
                  {admin && delivery.status !== "pending" ? (
                    <Button size="xs" icon={RotateCw} loading={busy === delivery.id} disabled={busy !== null || !hook?.enabled} title={hook?.enabled ? undefined : t("retryHint")} onClick={() => void redeliver(delivery.id)}>
                      {t("sendAgain")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Drawer>
  );
}

/** Every delivery that was given up on, across endpoints, so each can be sent again once its endpoint is back. */
export function DeadLettersDrawer({ open, admin, onClose, onChanged }: { open: boolean; admin: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("DeveloperDeliveries");
  const locale = useLocale();
  const { data, error, isLoading, mutate } = useApi<DeadLetter[]>(open ? WEBHOOKS_PATH : null, open ? { dead_letters: 1 } : undefined, FRESH);
  const { busy, redeliver } = useRedeliver(() => {
    void mutate();
    onChanged();
  });

  return (
    <Drawer open={open} onOpenChange={(next) => (next ? undefined : onClose())} icon={Inbox} title={t("deadTitle")} description={t("deadHint")} width={480}>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <LoadingState label={t("loadingQueue")} />
      ) : data.length === 0 ? (
        <EmptyState icon={Inbox} title={t("emptyQueue")}>{t("emptyQueueHint")}</EmptyState>
      ) : (
        <div className="flex flex-col">
          <p className="pb-2 text-105 leading-[15px] text-ink-3">
            {t("keepUntil")} {admin ? t("adminHelp") : t("viewerHelp")}
          </p>
          <ul className="flex flex-col">
            {data.map((letter) => (
              <li key={letter.id} className="flex items-start justify-between gap-3 border-t border-line py-2.5">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-115 font-medium text-ink">{letter.event_type}</span>
                    <span className="truncate text-105 text-ink-3">{t("to", {endpoint: letter.endpoint})}</span>
                  </div>
                  <span className="break-words text-105 leading-[15px] text-ink-2">{letter.last_error?.trim() || (letter.response_status ? t("response", {code: letter.response_status}) : t("noAnswer"))}</span>
                  <span className="text-105 text-ink-3">{formatDateTimeByLocale(letter.created_at, locale)} · {t("attemptCount", {count: letter.attempt})}</span>
                </div>
                {admin ? <Button size="xs" icon={RotateCw} loading={busy === letter.id} disabled={busy !== null} onClick={() => void redeliver(letter.id)}>{t("sendAgain")}</Button> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
