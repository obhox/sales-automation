import { useState } from "react";
import { Ellipsis, Inbox, Pause, Pencil, Play, Plus, ScrollText, Send, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, EmptyState, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Pill, Tooltip, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { plural } from "@/lib/client/format";
import { DeadLettersDrawer, DeliveriesDrawer } from "./DeliveryDrawers";
import { WebhookDialog } from "./WebhookDialog";
import { Chip, RowSkeleton } from "./parts";
import { HEALTH, WEBHOOKS_PATH, deadLetterTotal, eventChips, eventList, hookName, lastDeliveryCell, successCell, type WebhookRow } from "./model";

const GRID = "grid grid-cols-[minmax(150px,1fr)_180px_92px_124px_92px_28px] items-center gap-3 px-3.5";
const SUCCESS_TONE = { good: "text-good", warn: "text-warn", bad: "text-bad", neutral: "text-ink-3" };

interface TestResult {
  deliveries: Array<{ status: string; response_status: number | null; last_error: string | null } | null>;
}

/** Where events are sent: each endpoint's events, how its deliveries are going, and its log. */
export function WebhooksCard({ hooks, loading, error, admin, onRetry, onChanged }: {
  hooks: WebhookRow[] | undefined;
  loading: boolean;
  error: unknown;
  admin: boolean;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<{ hook: WebhookRow | null } | null>(null);
  const [log, setLog] = useState<WebhookRow | null>(null);
  const [deadOpen, setDeadOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const dead = hooks ? deadLetterTotal(hooks) : 0;

  async function run(hook: WebhookRow, work: () => Promise<void>) {
    // One thing at a time. The menus stay usable meanwhile (a disabled button would drop the keyboard's focus), so this is where a second action stops.
    if (busy) return;
    setBusy(hook.id);
    try {
      await work();
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const setEnabled = (hook: WebhookRow, enabled: boolean) =>
    run(hook, async () => {
      await api(WEBHOOKS_PATH, { method: "PATCH", body: { id: hook.id, enabled } });
      toast.success(enabled ? `${hookName(hook)} is receiving events again` : `${hookName(hook)} is paused`);
    });

  async function pause(hook: WebhookRow) {
    const ok = await confirm({
      title: `Pause ${hookName(hook)}?`,
      body: "Nothing is sent to it while it is paused, and events that happen meanwhile are not kept for it: they are not delivered when you resume. Deliveries already waiting are held until then.",
      confirmLabel: "Pause endpoint",
    });
    if (ok) await setEnabled(hook, false);
  }

  const test = (hook: WebhookRow) =>
    run(hook, async () => {
      const result = await api<TestResult>(WEBHOOKS_PATH, { method: "PUT", body: { id: hook.id } });
      const delivery = result.deliveries[0];
      if (delivery?.status === "delivered") toast.success(`${hookName(hook)} accepted the test event`, { description: `It answered ${delivery.response_status ?? 200}.` });
      else toast.error(`The test event was not accepted by ${hookName(hook)}`, { description: delivery?.last_error ?? "No answer came back. It will be tried again.", duration: 10_000 });
    });

  async function remove(hook: WebhookRow) {
    const ok = await confirm({
      title: `Remove ${hookName(hook)}?`,
      body: "Events stop being sent to it and its delivery log is deleted. Its signing secret cannot be recovered.",
      confirmLabel: "Remove endpoint",
      tone: "danger",
    });
    if (!ok) return;
    await run(hook, async () => {
      await api(WEBHOOKS_PATH, { method: "DELETE", query: { id: hook.id } });
      toast.success(`${hookName(hook)} was removed`);
    });
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-[11px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Outbound webhooks</h2>
          <p className="truncate text-11 text-ink-3">Signed with HMAC-SHA256 · up to 8 attempts, each after a longer wait</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dead > 0 ? (
            <button type="button" onClick={() => setDeadOpen(true)} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-bad-tint px-3 text-115 font-medium text-bad hover:bg-bad-tint/70">
              <Inbox size={13} aria-hidden="true" />
              {dead} in dead-letter queue
            </button>
          ) : null}
          {admin ? <Button size="sm" className="h-7 px-3" icon={Plus} onClick={() => setDialog({ hook: null })}>Add endpoint</Button> : null}
        </div>
      </div>

      {error && !hooks ? (
        <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={onRetry} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label="Webhook endpoints" className="min-w-[754px]">
            <div role="row" className={cn(GRID, "h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
              <span role="columnheader">Endpoint</span>
              <span role="columnheader">Events</span>
              <span role="columnheader">Success</span>
              <span role="columnheader">Last delivery</span>
              <span role="columnheader">Status</span>
              <span role="columnheader"><span className="sr-only">Actions</span></span>
            </div>
            {loading || !hooks ? <RowSkeleton label="Loading webhooks" /> : hooks.map((hook) => {
              const events = eventChips(hook.event_types);
              const success = successCell(hook);
              const last = lastDeliveryCell(hook);
              const health = HEALTH[hook.health];
              const troubled = hook.health === "retrying" || hook.health === "failing";
              const working = busy === hook.id;
              return (
                <div key={hook.id} role="row" aria-busy={working || undefined} className={cn(GRID, "h-14 border-t border-line", troubled && "bg-bad-tint", working && "opacity-60")}>
                  <div role="cell" className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-12 font-medium text-ink">{hookName(hook)}</span>
                    <span className="truncate text-10 text-ink-3" title={hook.url}>{hook.url}</span>
                  </div>
                  <div role="cell" className="flex min-w-0 flex-col items-start gap-[3px]">
                    <Chip mono={events.first !== "All events"}>{events.first}</Chip>
                    {events.more ? (
                      <Tooltip label={eventList(hook.event_types).slice(1).join(", ")}>
                        <span tabIndex={0} className="rounded-sm text-10 text-ink-3">{events.more}</span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <span role="cell" className={cn("text-115 font-medium", SUCCESS_TONE[success.tone])} title={hook.delivery_count > 0 ? `${hook.delivered} of ${hook.delivered + hook.retrying + hook.dead_letters} ${plural(hook.delivery_count, "delivery", "deliveries")} accepted` : undefined}>
                    {success.label}
                  </span>
                  <span role="cell" className={cn("truncate text-11", last.failed ? "text-bad" : "text-ink-2")}>{last.label}</span>
                  <div role="cell">
                    <Tooltip label={health.explain}>
                      <span tabIndex={0} className="inline-flex rounded-full"><Pill tone={health.tone} dot>{health.label}</Pill></span>
                    </Tooltip>
                  </div>
                  <div role="cell" className="flex justify-end">
                    <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${hookName(hook)}`} size={28} />}>
                      <MenuItem icon={ScrollText} onSelect={() => setLog(hook)}>Delivery log</MenuItem>
                      {admin ? (
                        <>
                          <MenuItem icon={Send} disabled={!hook.enabled} onSelect={() => void test(hook)}>Send a test event</MenuItem>
                          <MenuItem icon={Pencil} onSelect={() => setDialog({ hook })}>Edit endpoint</MenuItem>
                          {hook.enabled
                            ? <MenuItem icon={Pause} onSelect={() => void pause(hook)}>Pause</MenuItem>
                            : <MenuItem icon={Play} onSelect={() => void setEnabled(hook, true)}>Resume</MenuItem>}
                          <MenuSeparator />
                          <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(hook)}>Remove endpoint</MenuItem>
                        </>
                      ) : null}
                    </Menu>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {hooks && hooks.length === 0 ? (
        <EmptyState
          icon={Webhook} title="No webhook endpoints yet" className="border-t border-line"
          action={admin ? <Button variant="primary" icon={Plus} onClick={() => setDialog({ hook: null })}>Add endpoint</Button> : undefined}
        >
          {admin ? "Add an address and Linki will send it a signed request when a reply arrives, an email bounces, a meeting is booked and more." : "An admin can add an address for Linki to send events to."}
        </EmptyState>
      ) : null}

      {dialog ? <WebhookDialog key={dialog.hook?.id ?? "new"} hook={dialog.hook} onClose={() => setDialog(null)} onSaved={onChanged} /> : null}
      <DeliveriesDrawer hook={log} admin={admin} onClose={() => setLog(null)} onChanged={onChanged} />
      <DeadLettersDrawer open={deadOpen} admin={admin} onClose={() => setDeadOpen(false)} onChanged={onChanged} />
    </Card>
  );
}
