import { useState } from "react";
import { Inbox, RotateCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Button, Drawer, EmptyState, ErrorState, LoadingState, Pill } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime, plural } from "@/lib/client/format";
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
  const [busy, setBusy] = useState<string | null>(null);
  async function redeliver(id: string) {
    setBusy(id);
    try {
      const result = await api<Redelivered>(WEBHOOKS_PATH, { method: "PUT", body: { delivery_id: id } });
      if (result.status === "delivered") toast.success("Sent again and accepted", { description: `The endpoint answered ${result.response_status ?? 200}.` });
      else if (result.status === "pending") toast.message("Waiting to be sent", { description: "Its endpoint is paused. It goes out when the endpoint is resumed." });
      else toast.error("Sent again, and not accepted", { description: result.last_error ?? "No answer came back. It will be tried again.", duration: 10_000 });
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
  const { data, error, isLoading, mutate } = useApi<Delivery[]>(hook ? WEBHOOKS_PATH : null, hook ? { deliveries: hook.id } : undefined, FRESH);
  const { busy, redeliver } = useRedeliver(() => {
    void mutate();
    onChanged();
  });

  return (
    <Drawer open={Boolean(hook)} onOpenChange={(next) => (next ? undefined : onClose())} icon={ScrollText} title="Delivery log" description={hook ? hookName(hook) : undefined} width={480}>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <LoadingState label="Loading deliveries" />
      ) : data.length === 0 ? (
        <EmptyState icon={ScrollText} title="Nothing sent yet">Deliveries appear here as events happen. “Send a test event” makes one now.</EmptyState>
      ) : (
        <div className="flex flex-col">
          <p className="pb-2 text-105 text-ink-3">The latest {data.length} {plural(data.length, "delivery", "deliveries")}, newest first.</p>
          <ul className="flex flex-col">
            {data.map((delivery) => {
              const status = DELIVERY_STATUS[delivery.status] ?? { label: delivery.status, tone: "neutral" as const };
              return (
                <li key={delivery.id} className="flex items-start justify-between gap-3 border-t border-line py-2.5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-115 font-medium text-ink">{delivery.event_type}</span>
                      <Pill tone={status.tone} size="sm">{status.label}</Pill>
                    </div>
                    <span className="break-words text-105 leading-[15px] text-ink-2">{deliveryDetail(delivery)}</span>
                    <span className="text-105 text-ink-3">{formatDateTime(delivery.created_at)}</span>
                  </div>
                  {admin && delivery.status !== "pending" ? (
                    <Button size="xs" icon={RotateCw} loading={busy === delivery.id} disabled={busy !== null || !hook?.enabled} title={hook?.enabled ? undefined : "Resume the endpoint to send to it"} onClick={() => void redeliver(delivery.id)}>
                      Send again
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
  const { data, error, isLoading, mutate } = useApi<DeadLetter[]>(open ? WEBHOOKS_PATH : null, open ? { dead_letters: 1 } : undefined, FRESH);
  const { busy, redeliver } = useRedeliver(() => {
    void mutate();
    onChanged();
  });

  return (
    <Drawer open={open} onOpenChange={(next) => (next ? undefined : onClose())} icon={Inbox} title="Dead-letter queue" description="Deliveries given up on after eight attempts" width={480}>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <LoadingState label="Loading the queue" />
      ) : data.length === 0 ? (
        <EmptyState icon={Inbox} title="The queue is empty">No delivery is waiting to be sent again.</EmptyState>
      ) : (
        <div className="flex flex-col">
          <p className="pb-2 text-105 leading-[15px] text-ink-3">
            These are kept until they are sent again or their endpoint is removed. {admin ? "Fix the endpoint first, then send each again." : "An admin can send them again."}
          </p>
          <ul className="flex flex-col">
            {data.map((letter) => (
              <li key={letter.id} className="flex items-start justify-between gap-3 border-t border-line py-2.5">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-115 font-medium text-ink">{letter.event_type}</span>
                    <span className="truncate text-105 text-ink-3">to {letter.endpoint}</span>
                  </div>
                  <span className="break-words text-105 leading-[15px] text-ink-2">{letter.last_error?.trim() || (letter.response_status ? `Answered ${letter.response_status}` : "No answer")}</span>
                  <span className="text-105 text-ink-3">{formatDateTime(letter.created_at)} · {letter.attempt} {plural(letter.attempt, "attempt", "attempts")}</span>
                </div>
                {admin ? <Button size="xs" icon={RotateCw} loading={busy === letter.id} disabled={busy !== null} onClick={() => void redeliver(letter.id)}>Send again</Button> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
