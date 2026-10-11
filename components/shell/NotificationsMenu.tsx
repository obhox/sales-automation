import { useState } from "react";
import { useRouter } from "next/router";
import { Bell, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState, IconButton, LoadingState, Popover } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatRelative } from "@/lib/client/format";
import type { NotificationRow } from "@/lib/platform/notifications";
import { useShell } from "./useShell";

const TONE: Record<string, { icon: LucideIcon; className: string }> = {
  good: { icon: CircleCheck, className: "bg-good-tint text-good" },
  warn: { icon: TriangleAlert, className: "bg-warn-tint text-warn" },
  bad: { icon: OctagonAlert, className: "bg-bad-tint text-bad" },
  info: { icon: Info, className: "bg-brand-tint text-brand" },
};

/** The bell: what has happened that this member has not seen yet. */
export function NotificationsMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: shell, mutate: refreshShell } = useShell();
  // Only asked for while the list is open; the unread count on the bell comes with the frame.
  const { data, error, isLoading, mutate } = useApi<{ notifications: NotificationRow[]; unread: number }>(open ? "/api/notifications" : null);
  const unread = shell?.counts.notifications ?? 0;

  const settle = async (request: Promise<unknown>) => {
    try {
      await request;
      await Promise.all([mutate(), refreshShell()]);
    } catch (failure) {
      toast.error(errorMessage(failure));
    }
  };

  const follow = (notification: NotificationRow) => {
    if (!notification.read) void settle(api("/api/notifications", { method: "POST", body: { action: "read", id: notification.id } }));
    if (notification.link) {
      setOpen(false);
      void router.push(notification.link);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[360px] p-0"
      trigger={<IconButton icon={Bell} label={unread ? `Notifications, ${unread} unread` : "Notifications"} variant="surface" dot={unread > 0} />}
    >
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <h2 className="text-13 font-semibold text-ink">Notifications</h2>
        {data && data.unread > 0 ? (
          <button type="button" onClick={() => void settle(api("/api/notifications", { method: "POST", body: { action: "read_all" } }))} className="text-11 font-semibold text-brand-strong hover:underline">
            Mark all read
          </button>
        ) : null}
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {error ? (
          <ErrorState message={error.message} onRetry={() => void mutate()} />
        ) : isLoading || !data ? (
          <LoadingState label="Loading notifications" />
        ) : data.notifications.length === 0 ? (
          <EmptyState icon={Bell} title="Nothing new">Replies, paused mailboxes and finished imports will show up here.</EmptyState>
        ) : (
          <ul>
            {data.notifications.map(notification => {
              const tone = TONE[notification.tone] ?? TONE.info;
              const Glyph = tone.icon;
              return (
                <li key={notification.id} className="border-b border-line last:border-b-0">
                  <button type="button" onClick={() => follow(notification)} className={cn("flex w-full gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-subtle", !notification.read && "bg-brand-tint/40")}>
                    <span className={cn("mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full", tone.className)}>
                      <Glyph size={12} aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="flex items-start justify-between gap-2">
                        <span className={cn("text-12 leading-4 text-ink", notification.read ? "font-medium" : "font-semibold")}>{notification.title}</span>
                        <span className="shrink-0 text-105 text-ink-3">{formatRelative(notification.created_at)}</span>
                      </span>
                      {notification.body ? <span className="text-11 leading-[15px] text-ink-2">{notification.body}</span> : null}
                    </span>
                    {notification.read ? null : <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Popover>
  );
}
